"""Durable local accounts, wallet, generation and conversations."""

import base64
import hashlib
import hmac
import io
import json
import logging
import os
import re
import secrets
import smtplib
import ssl
import threading
import time
import uuid
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from contextlib import closing
from email.message import EmailMessage
from pathlib import Path
from urllib.parse import quote

from PIL import Image, ImageDraw, ImageOps

import commercial_documents as documents
import commercial_formats as formats
import commercial_ecommerce as ecommerce
import commercial_image_policy as image_policy
import commercial_provider as provider
import commercial_upscale as upscale
import commercial_web_search as web_search
from commercial_billing import CREDIT_ADJUSTMENT_MAX

MAX_GENERATION_CONCURRENCY = 20

_previews = {}
_preview_lock = threading.Lock()


def _publish_job_preview(identifier, image_bytes):
    try:
        with Image.open(io.BytesIO(image_bytes)) as image:
            if image.width * image.height > documents.MAX_IMAGE_PIXELS:
                return
            image.thumbnail((960, 960), Image.Resampling.LANCZOS)
            output = io.BytesIO()
            image.convert("RGBA").save(output, "PNG")
    except (OSError, ValueError, Image.DecompressionBombError):
        return
    with _preview_lock:
        _previews[identifier] = (uuid.uuid4().hex, output.getvalue())


def job_preview(identifier):
    with _preview_lock:
        return _previews.get(identifier)


class CommercialError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def setup(db, data):
    provider.setup(db, data / "provider-secret.key")
    upscale.setup(db)
    image_policy.setup(db)
    db.executescript("""
        CREATE TABLE IF NOT EXISTS invites (
            hash TEXT PRIMARY KEY, expires INTEGER NOT NULL, used_by INTEGER
        );
        CREATE TABLE IF NOT EXISTS credit_codes (
            hash TEXT PRIMARY KEY, amount INTEGER NOT NULL, expires INTEGER NOT NULL, used_by INTEGER
        );
        CREATE TABLE IF NOT EXISTS email_challenges (
            email TEXT, purpose TEXT, hash TEXT NOT NULL, expires INTEGER NOT NULL,
            created INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(email, purpose)
        );
        CREATE TABLE IF NOT EXISTS operations_audit (
            id INTEGER PRIMARY KEY, actor INTEGER NOT NULL, action TEXT NOT NULL,
            target TEXT NOT NULL, created INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS generation_jobs (
            id TEXT PRIMARY KEY, owner INTEGER NOT NULL REFERENCES users(id),
            request_id TEXT NOT NULL, scope TEXT NOT NULL, label TEXT NOT NULL,
            model_id TEXT NOT NULL, model_name TEXT NOT NULL, provider_model TEXT NOT NULL,
            price INTEGER NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
            asset_id TEXT, submitted_size TEXT, width INTEGER, height INTEGER, error TEXT,
            upstream_id TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL,
            UNIQUE(owner, request_id)
        );
        CREATE INDEX IF NOT EXISTS generation_queue ON generation_jobs(status,created);
        CREATE INDEX IF NOT EXISTS generation_owner ON generation_jobs(owner,created);
        CREATE TABLE IF NOT EXISTS generation_settings (
            id INTEGER PRIMARY KEY CHECK(id=1), concurrency INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO generation_settings(id, concurrency) VALUES(1, 10);
        CREATE TABLE IF NOT EXISTS asset_details (
            asset_id TEXT PRIMARY KEY REFERENCES assets(id), job_id TEXT REFERENCES generation_jobs(id),
            parent_id TEXT, tags TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
            trashed INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'upload'
        );
        CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY, owner INTEGER NOT NULL REFERENCES users(id),
            title TEXT NOT NULL, updated INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chat_turns (
            id INTEGER PRIMARY KEY, conversation TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            request_id TEXT NOT NULL, user_text TEXT NOT NULL, reply TEXT NOT NULL DEFAULT '',
            model_name TEXT NOT NULL, price INTEGER NOT NULL, status TEXT NOT NULL,
            created INTEGER NOT NULL, UNIQUE(conversation, request_id)
        );
        CREATE TABLE IF NOT EXISTS chat_billing (
            owner INTEGER PRIMARY KEY REFERENCES users(id), remainder INTEGER NOT NULL
        );
    """)
    db.execute("""UPDATE generation_jobs SET status='failed', error=?, updated=?
        WHERE status='running' AND json_extract(payload,'$.upscaleMethod')='local'""",
               ("工作台重启时本地放大中断，请重新提交。", now()))
    db.execute("UPDATE generation_jobs SET status='unknown', error=?, updated=? WHERE status='running'",
               ("服务在请求执行期间停止，请核对上游结果。", now()))
    db.execute("UPDATE chat_turns SET status='unknown' WHERE status='running'")
    columns = {item["name"] for item in db.execute("PRAGMA table_info(email_challenges)")}
    if "invite_hash" not in columns:
        db.execute("ALTER TABLE email_challenges ADD COLUMN invite_hash TEXT")
    job_columns = {item["name"] for item in db.execute("PRAGMA table_info(generation_jobs)")}
    if "review" not in job_columns:
        db.execute("ALTER TABLE generation_jobs ADD COLUMN review TEXT")
    if "hidden_at" not in job_columns:
        db.execute("ALTER TABLE generation_jobs ADD COLUMN hidden_at INTEGER")
    turn_columns = {item["name"] for item in db.execute("PRAGMA table_info(chat_turns)")}
    for name in ("token_rates", "token_usage", "upstream_id", "asset_ids", "web_search"):
        if name not in turn_columns:
            db.execute(f"ALTER TABLE chat_turns ADD COLUMN {name} TEXT")


def now():
    return int(time.time())


def text(value, label, limit, minimum=1):
    if not isinstance(value, str) or not minimum <= len(value.strip()) <= limit:
        raise CommercialError(400, f"{label}须为 {minimum} 至 {limit} 个字符。")
    return value.strip()


def code_hash(value):
    return hashlib.sha256(value.encode()).hexdigest()


def audit(db, actor, action, target):
    db.execute("INSERT INTO operations_audit(actor,action,target,created) VALUES(?,?,?,?)",
               (actor, action, str(target), now()))


def issue_code(db, actor, kind, payload):
    days = payload.get("days", 7)
    amount = payload.get("amount")
    if type(days) is not int or not 1 <= days <= 90:
        raise CommercialError(400, "有效期为 1 至 90 天。")
    code = secrets.token_urlsafe(18)
    expires = now() + days * 86400
    if kind == "invites":
        db.execute("INSERT INTO invites(hash,expires) VALUES(?,?)", (code_hash(code), expires))
    else:
        if type(amount) is not int or not 1 <= amount <= CREDIT_ADJUSTMENT_MAX:
            raise CommercialError(400, "请输入有效积分金额。")
        db.execute("INSERT INTO credit_codes(hash,amount,expires) VALUES(?,?,?)", (code_hash(code), amount, expires))
    audit(db, actor, "创建邀请码" if kind == "invites" else "创建兑换码", code_hash(code)[:12])
    return {"code": code, "expires": expires}


def validate_invite(db, raw):
    value = text(raw, "邀请码", 80)
    token = code_hash(value)
    row = db.execute("SELECT 1 FROM invites WHERE hash=? AND expires>? AND used_by IS NULL",
                     (token, now())).fetchone()
    if not row:
        raise CommercialError(400, "邀请码无效、已用或已过期。")
    return token


def change_points(db, owner, amount, label, reference=None):
    if amount:
        changed = db.execute("UPDATE users SET points=points+? WHERE id=? AND points+?>=0",
                             (amount, owner, amount)).rowcount
        if not changed:
            raise CommercialError(409, "可用积分不足。")
    db.execute("INSERT INTO ledger(user_id,label,amount,created,job_id) VALUES(?,?,?,?,?)",
               (owner, label, amount, now(), reference))


def redeem(db, owner, raw):
    digest = code_hash(text(raw, "兑换码", 80))
    row = db.execute("SELECT amount FROM credit_codes WHERE hash=? AND expires>? AND used_by IS NULL",
                     (digest, now())).fetchone()
    if not row:
        raise CommercialError(400, "兑换码无效、已用或已过期。")
    db.execute("UPDATE credit_codes SET used_by=? WHERE hash=?", (owner, digest))
    change_points(db, owner, row["amount"], "兑换积分", "credit:" + digest[:32])


def send_code(db, data, email, purpose, raw_invite=None):
    if purpose not in ("register", "reset"):
        raise CommercialError(400, "验证码用途无效。")
    invite = validate_invite(db, raw_invite) if purpose == "register" else None
    exists = db.execute("SELECT active FROM users WHERE email=?", (email,)).fetchone()
    if (purpose == "reset" and (not exists or not exists["active"])) or (purpose == "register" and exists):
        return {"ok": True}
    previous = db.execute("SELECT created FROM email_challenges WHERE email=? AND purpose=?", (email, purpose)).fetchone()
    if previous and now() - previous["created"] < 60:
        raise CommercialError(429, "请等待 60 秒后再发送。")
    if invite:
        bound = db.execute("SELECT email FROM email_challenges WHERE invite_hash=? AND expires>? AND email<>?",
                           (invite, now(), email)).fetchone()
        if bound:
            raise CommercialError(409, "邀请码已用于另一邮箱的验证。")
    code = f"{secrets.randbelow(1000000):06d}"
    digest = code_hash(email + purpose + code)
    db.execute("""INSERT INTO email_challenges(email,purpose,hash,expires,created,invite_hash) VALUES(?,?,?,?,?,?)
        ON CONFLICT(email,purpose) DO UPDATE SET hash=excluded.hash,expires=excluded.expires,
        created=excluded.created,invite_hash=excluded.invite_hash,attempts=0""", (email, purpose, digest, now() + 600, now(), invite))
    body = f"你的{'注册' if purpose == 'register' else '找回密码'}验证码是 {code}，10 分钟内有效。"
    host = os.environ.get("FENGSHA_SMTP_HOST")
    if host:
        message = EmailMessage()
        message["Subject"] = "风沙生图工作台验证码"
        message["From"] = os.environ.get("FENGSHA_SMTP_FROM") or os.environ["FENGSHA_SMTP_USER"]
        message["To"] = email
        message.set_content(body)
        try:
            with smtplib.SMTP_SSL(host, int(os.environ.get("FENGSHA_SMTP_PORT", "465")),
                                  timeout=12, context=ssl.create_default_context()) as smtp:
                smtp.login(os.environ["FENGSHA_SMTP_USER"], os.environ["FENGSHA_SMTP_PASSWORD"])
                smtp.send_message(message)
        except (OSError, smtplib.SMTPException, KeyError) as error:
            raise CommercialError(502, "邮件发送失败，请检查 SMTP 配置。") from error
    else:
        outbox = data / "mail-outbox"
        outbox.mkdir(exist_ok=True)
        (outbox / (uuid.uuid4().hex + ".txt")).write_text(f"To: {email}\n\n{body}\n", encoding="utf-8")
    return {"ok": True}


def verify_code(db, email, purpose, raw, invite=None):
    row = db.execute("SELECT * FROM email_challenges WHERE email=? AND purpose=?", (email, purpose)).fetchone()
    if not row or row["expires"] <= now() or row["attempts"] >= 5:
        raise CommercialError(400, "验证码已失效，请重新发送。")
    if invite != row["invite_hash"]:
        raise CommercialError(400, "请用发送验证码时填写的邀请码。")
    digest = code_hash(email + purpose + str(raw))
    if not hmac.compare_digest(row["hash"], digest):
        db.execute("UPDATE email_challenges SET attempts=attempts+1 WHERE email=? AND purpose=?", (email, purpose))
        db.commit()
        raise CommercialError(400, "验证码不正确。")
    db.execute("DELETE FROM email_challenges WHERE email=? AND purpose=?", (email, purpose))


def owned_asset(db, owner, identifier, image_only=False, include_trash=False):
    row = db.execute("""SELECT a.*, COALESCE(d.trashed,0) AS trashed, COALESCE(d.kind,'upload') AS kind
        FROM assets a LEFT JOIN asset_details d ON d.asset_id=a.id WHERE a.id=? AND a.user_id=?""",
                     (identifier, owner)).fetchone()
    if not row or (row["trashed"] and not include_trash):
        raise CommercialError(404, "素材不存在或不可用。")
    if image_only and row["mime"] not in provider.IMAGE_TYPES:
        raise CommercialError(400, "请选择 PNG、JPEG、WebP 或 GIF 图片。")
    return row


def list_assets(db, owner, trash=False):
    rows = db.execute("""SELECT a.id,a.name,a.mime,a.size,a.created,COALESCE(d.kind,'upload') AS kind,
        COALESCE(d.tags,'') AS tags,COALESCE(d.notes,'') AS notes,d.parent_id AS parentId,d.job_id AS jobId,
        j.model_name AS modelName,j.width,j.height
        FROM assets a LEFT JOIN asset_details d ON d.asset_id=a.id
        LEFT JOIN generation_jobs j ON j.id=d.job_id
        WHERE a.user_id=? AND COALESCE(d.trashed,0)=? ORDER BY a.created DESC,a.rowid DESC""",
                      (owner, int(trash)))
    return [dict(row) for row in rows]


def asset_metadata(db, owner, identifier, payload):
    asset = owned_asset(db, owner, identifier, include_trash=True)
    if "trashed" in payload:
        if type(payload["trashed"]) is not bool:
            raise CommercialError(400, "素材状态无效。")
        db.execute("""INSERT INTO asset_details(asset_id,trashed) VALUES(?,?)
            ON CONFLICT(asset_id) DO UPDATE SET trashed=excluded.trashed""", (identifier, int(payload["trashed"])))
        return {"ok": True}
    name = text(payload.get("name"), "素材名称", 120)
    extension = Path(asset["name"]).suffix
    if extension and not name.lower().endswith(extension.lower()):
        name += extension
    tags = text(payload.get("tags", ""), "标签", 200, 0)
    notes = text(payload.get("notes", ""), "备注", 2000, 0)
    db.execute("UPDATE assets SET name=? WHERE id=?", (name, identifier))
    db.execute("""INSERT INTO asset_details(asset_id,tags,notes) VALUES(?,?,?)
        ON CONFLICT(asset_id) DO UPDATE SET tags=excluded.tags,notes=excluded.notes""", (identifier, tags, notes))
    return {"ok": True}


def prompt_record(db, owner, identifier):
    owned_asset(db, owner, identifier)
    row = db.execute("""SELECT j.payload,j.model_name,j.provider_model,j.submitted_size,j.width,j.height,j.id
        FROM asset_details d JOIN generation_jobs j ON j.id=d.job_id WHERE d.asset_id=?""",
                     (identifier,)).fetchone()
    if not row:
        return {"prompt": None}
    request = json.loads(row["payload"])
    return {"prompt": request.get("actualPrompt", request["prompt"]), "modelName": row["model_name"], "model": row["provider_model"],
            "referenceIds": request["imageIds"], "requestedSize": request["size"],
            "submittedSize": row["submitted_size"], "width": row["width"], "height": row["height"], "jobId": row["id"]}


def job_record(row):
    payload = json.loads(row["payload"])
    context = payload.get("context", {})
    if row["scope"] == "image" and not context.get("operation"):
        legacy_edits = {"圈选修改", "换背景", "抠图", "扩图", "超分", "裁剪缩放", "图片文字提取"}
        editing = payload.get("mask") or payload.get("regions") or row["label"] in legacy_edits
        context["operation"] = "edit" if editing else "generate"
    preview = job_preview(row["id"]) if row["status"] == "running" else None
    return {"id": row["id"], "scope": row["scope"], "label": row["label"], "modelName": row["model_name"],
            "hidden": row["hidden_at"] is not None,
            "status": row["status"], "price": row["price"], "assetId": row["asset_id"],
            "requestedSize": payload["size"], "submittedSize": row["submitted_size"], "width": row["width"], "height": row["height"],
            "error": row["error"], "review": row["review"], "upstreamId": row["upstream_id"],
            "created": row["created"], "updated": row["updated"], "previewVersion": preview[0] if preview else None,
            "context": context, "upscaleMethod": payload.get("upscaleMethod"),
            "storyboardSize": payload.get("storyboardSize")}


def job_detail(db, owner, identifier, *, store=None):
    row = db.execute("SELECT * FROM generation_jobs WHERE id=? AND owner=?", (identifier, owner)).fetchone()
    if not row:
        raise CommercialError(404, "任务不存在。")
    record = job_record(row)
    if store is not None:
        payload = json.loads(row["payload"])
        record["prompt"] = payload.get("actualPrompt", payload["prompt"])
        record["canCheckResult"] = (row["status"] == "unknown" and bool(row["upstream_id"])
                                    and payload.get("upscaleMethod") == "aliyun")
        inputs = []
        for asset_id in payload.get("imageIds", []):
            asset = db.execute("""SELECT a.name, COALESCE(d.trashed,0) AS trashed, d.job_id
                FROM assets a LEFT JOIN asset_details d ON d.asset_id=a.id WHERE a.id=? AND a.user_id=?""",
                               (asset_id, owner)).fetchone()
            inputs.append({"id": asset_id, "name": asset["name"] if asset else "原图已不可用",
                           "available": bool(asset and not asset["trashed"] and store.exists(asset_id)),
                           "trashed": bool(asset and asset["trashed"]),
                           "jobId": asset["job_id"] if asset else None})
        record["inputs"] = inputs
        if record["assetId"]:
            try:
                result = owned_asset(db, owner, record["assetId"], include_trash=True)
                record["assetAvailable"] = not result["trashed"] and store.exists(result["id"])
            except CommercialError:
                record["assetAvailable"] = False
    return record


def check_upscale_job(db, owner, identifier, store):
    row = db.execute("SELECT * FROM generation_jobs WHERE id=? AND owner=?", (identifier, owner)).fetchone()
    if (not row or row["status"] != "unknown" or not row["upstream_id"]
            or json.loads(row["payload"]).get("upscaleMethod") != "aliyun"):
        raise CommercialError(409, "此任务没有可继续查询的百炼任务编号。")
    upscale.ready(db, owner, "aliyun")
    db.execute("UPDATE generation_jobs SET status='queued',error=NULL,updated=? WHERE id=? AND status='unknown'",
               (now(), identifier))
    return job_detail(db, owner, identifier, store=store)


def generation_output(scope, value, image_ids, mask):
    if value is None:
        return None
    if scope != "image" or not isinstance(value, dict) or value.get("format") not in ("gif", "svg"):
        raise CommercialError(400, "输出格式无效。")
    output_format = value["format"]
    method = value.get("method", "native")
    if method not in ("native", "sheet" if output_format == "gif" else "trace"):
        raise CommercialError(400, "该格式不支持所选制作方式。")
    if mask or (output_format == "svg" and image_ids):
        raise CommercialError(400, "此格式不支持圈选编辑，SVG 使用文字生成。")
    if output_format == "svg":
        if method == "trace" and not formats.tracer_available():
            raise CommercialError(503, "当前工作台缺少矢量描摹组件。")
        return {"format": "svg", "method": method}
    frames, duration = value.get("frames"), value.get("frameDurationMs")
    if (type(frames) is not int or not formats.GIF_MIN_FRAMES <= frames <= formats.GIF_MAX_FRAMES
            or type(duration) is not int or not formats.GIF_MIN_FRAME_DURATION_MS <= duration <= formats.GIF_MAX_FRAME_DURATION_MS
            or duration % formats.GIF_DURATION_STEP_MS):
        raise CommercialError(400, "GIF 可用 2–16 帧，每帧 20–2000 毫秒（按 10 毫秒递增）。")
    if method == "sheet" and frames not in formats.GRID:
        raise CommercialError(400, "分镜合成支持 4、6、8、9、12 或 16 帧。")
    output = {"format": "gif", "method": method, "frames": frames, "frameDurationMs": duration}
    if "sequence" in value:
        if method != "sheet" or type(value["sequence"]) is not bool:
            raise CommercialError(400, "分段生成设置无效。")
        output["sequence"] = value["sequence"]
    return output


def check_generation_output(model, output):
    if output and output.get("method", "native") == "native" and output["format"] not in model["capabilities"]:
        raise CommercialError(409, "当前模型未开通所选输出格式。")


def submit_jobs(db, owner, body, *, upscale_method=None):
    requests = body.get("requests")
    if not isinstance(requests, list) or not 1 <= len(requests) <= 12:
        raise CommercialError(400, "一次可提交 1 至 12 个任务。")
    records = []
    for item in requests:
        if not isinstance(item, dict):
            raise CommercialError(400, "生成参数格式无效。")
        request_id = text(item.get("requestId"), "请求号", 80)
        existing = db.execute("SELECT * FROM generation_jobs WHERE owner=? AND request_id=?", (owner, request_id)).fetchone()
        if existing:
            records.append(job_record(existing))
            continue
        scope = item.get("scope")
        if scope not in ("image", "poster", "ppt"):
            raise CommercialError(400, "任务所属工作台无效。")
        prompt = text(item.get("prompt"), "生成提示词", 12000)
        label = text(item.get("label"), "任务名称", 100)
        size = item.get("size")
        if not isinstance(size, str) or not re.fullmatch(r"\d{1,4}x\d{1,4}", size) or any(
                not (1 if upscale_method else 64) <= int(dim) <= (8192 if upscale_method else 4096)
                for dim in size.split("x")):
            raise CommercialError(400, "输出尺寸无效。")
        image_ids = item.get("imageIds", [])
        if (not isinstance(image_ids, list) or len(image_ids) > provider.MAX_INPUT_IMAGES
                or any(not isinstance(key, str) for key in image_ids) or len(set(image_ids)) != len(image_ids)):
            raise CommercialError(400, "参考图片格式无效。")
        for identifier in image_ids:
            owned_asset(db, owner, identifier, image_only=True)
        mask = item.get("mask")
        regions = item.get("regions")
        if mask is not None and (not image_ids or regions is not None or not valid_rectangle(mask)):
            raise CommercialError(400, "请圈选有效的原图区域。")
        if regions is not None:
            regions = edit_regions(regions, image_ids)
        output = generation_output(scope, item.get("output"), image_ids, regions or mask)
        if output and output.get("method") == "sheet" and any(int(dim) > formats.GIF_MAX_EDGE for dim in size.split("x")):
            raise CommercialError(400, f"分镜合成的单帧尺寸最大为 {formats.GIF_MAX_EDGE} 像素。")
        raw_context = item.get("context")
        poster_shot = raw_context.get("posterShot") if scope == "poster" and isinstance(raw_context, dict) else None
        if poster_shot is not None:
            if not isinstance(poster_shot, str) or poster_shot not in ecommerce.SHOT_RULES:
                raise CommercialError(400, "海报出图方向无效。")
            prompt = ecommerce.shot_instructions(poster_shot) + "\n" + prompt
        effective_prompt = region_prompt(prompt, regions, image_ids) if regions else prompt
        if len(effective_prompt) > 12000:
            raise CommercialError(400, "修改描述过长，请精简后再提交。")
        if upscale_method:
            name, identifier = upscale.METHODS[upscale_method]
            model = {"name": name, "id": identifier, "model": identifier, "price": 0}
        else:
            check_image_policy(db, effective_prompt)
            capability = image_capability(image_ids, regions or mask)
            model = provider.resolve(db, "image", item.get("modelId"), capability)
            check_generation_output(model, output)
            check_image_count(model, image_ids)
        if type(item.get("unitPrice")) is not int or item["unitPrice"] != model["price"]:
            raise CommercialError(409, "模型价格已更新，请重新查看报价。")
        identifier = uuid.uuid4().hex
        if model["price"]:
            change_points(db, owner, -model["price"], "预留 · " + label, "reserve:" + identifier)
        context = {}
        if raw_context is not None:
            if not isinstance(raw_context, dict):
                raise CommercialError(400, "项目上下文无效。")
            context["documentId"] = text(raw_context.get("documentId"), "项目引用", 60)
            if scope == "image" and raw_context.get("operation") in ("generate", "edit"):
                context["operation"] = raw_context["operation"]
                tool = raw_context.get("tool")
                if isinstance(tool, str) and re.fullmatch(r"[a-z][a-z_]{0,40}", tool):
                    context["tool"] = tool
            if scope == "poster" and "formatId" in raw_context:
                format_id = raw_context["formatId"]
                if not isinstance(format_id, str) or format_id not in POSTER_FORMATS:
                    raise CommercialError(400, "海报尺寸标识无效。")
                context["formatId"] = format_id
            if poster_shot:
                context["posterShot"] = poster_shot
            if scope == "ppt":
                index, phase = raw_context.get("index"), raw_context.get("phase")
                if type(index) is not int or not 0 <= index < 12 or phase not in ("board", "final", "redo"):
                    raise CommercialError(400, "幻灯片上下文无效。")
                context.update(index=index, phase=phase)
                if raw_context.get("regenerate") is True:
                    context["regenerate"] = True
                if raw_context.get("generationId"):
                    context["generationId"] = text(raw_context["generationId"], "PPT 版本引用", 60)
                if raw_context.get("reviewModel") and phase != "board":
                    checker = provider.resolve(db, "chat", raw_context["reviewModel"], "vision")
                    context["reviewModel"] = checker["id"]
        payload = {"prompt": prompt, "size": size, "imageIds": image_ids, "mask": mask, "context": context}
        if upscale_method:
            payload["upscaleMethod"] = upscale_method
        if output:
            context["operation"] = "generate"
            context["outputFormat"] = output["format"]
            context["outputMethod"] = output["method"]
            payload["output"] = output
        if regions:
            payload.update(regions=regions, actualPrompt=effective_prompt)
        params = json.dumps(payload, ensure_ascii=False)
        db.execute("""INSERT INTO generation_jobs(id,owner,request_id,scope,label,model_id,model_name,
            provider_model,price,payload,status,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,'queued',?,?)""",
                   (identifier, owner, request_id, scope, label, model["id"], model["name"], model["model"],
                    model["price"], params, now(), now()))
        records.append(job_detail(db, owner, identifier))
    return {"jobs": records}


def finish_job(db, row, status, error=None, upstream_id=None):
    db.execute("UPDATE generation_jobs SET status=?,error=?,upstream_id=COALESCE(?,upstream_id),updated=? WHERE id=?",
               (status, error, upstream_id, now(), row["id"]))
    if not row["price"]:
        return
    if status in ("failed", "cancelled"):
        change_points(db, row["owner"], row["price"], "释放 · " + row["label"], "release:" + row["id"])
    elif status == "succeeded":
        change_points(db, row["owner"], 0, "结算 · " + row["label"], "settle:" + row["id"])


def image_capability(image_ids, mask):
    return "mask" if mask else "multiReference" if len(image_ids) > 1 else "reference" if image_ids else "generate"


def check_image_policy(db, prompt):
    if not image_policy.settings(db)["enabled"]:
        return prompt
    reason = image_policy.violation(prompt)
    if reason:
        raise CommercialError(422, reason)
    return image_policy.apply(prompt)


def check_image_count(model, image_ids):
    if len(image_ids) > model["maxReferences"]:
        raise CommercialError(400, f"当前模型最多可提交 {model['maxReferences']} 张图片，包含原图。")
    if len(image_ids) > 1 and "multiReference" not in model["capabilities"]:
        raise CommercialError(400, "当前模型未开启多图输入。")


def valid_rectangle(value):
    return (isinstance(value, dict)
            and all(type(value.get(key)) in (int, float) and 0 <= value[key] <= 100 for key in "xywh")
            and value["w"] > 0 and value["h"] > 0
            and value["x"] + value["w"] <= 100.01 and value["y"] + value["h"] <= 100.01)


def edit_regions(values, image_ids):
    if not image_ids or not isinstance(values, list) or not 1 <= len(values) <= 12:
        raise CommercialError(400, "请在原图圈选 1 至 12 个有效区域。")
    regions = []
    for item in values:
        if not valid_rectangle(item):
            raise CommercialError(400, "修改区域超出原图范围。")
        region = {key: item[key] for key in "xywh"}
        region["note"] = text(item.get("note", ""), "区域说明", 600, minimum=0)
        reference_id = item.get("referenceId")
        placement = item.get("referencePlacement")
        if reference_id is not None:
            if reference_id not in image_ids[1:]:
                raise CommercialError(400, "请重新绑定已上传的参考图。")
            if placement is not None and (not valid_rectangle(placement)
                    or any(placement[axis] < region[axis] - .01
                           or placement[axis] + placement[length] > region[axis] + region[length] + .01
                           for axis, length in (("x", "w"), ("y", "h")))):
                raise CommercialError(400, "参考图摆放范围超出所属选区。")
            region["referenceId"] = reference_id
            region["referencePlacement"] = {key: (placement or item)[key] for key in "xywh"}
        elif placement is not None:
            raise CommercialError(400, "请先为摆放位置选择一张参考图。")
        regions.append(region)
    return regions


def region_prompt(prompt, regions, image_ids):
    lines = [prompt, "以第一张图为待编辑图。只编辑蒙版内的指定区域，保留其他内容、构图和文字。"]
    for index, region in enumerate(regions, 1):
        x, y, w, h = (region[key] for key in "xywh")
        line = f"区域 {index}（左 {x:g}%、上 {y:g}%、宽 {w:g}%、高 {h:g}%）：{region['note'] or '按整体修改要求处理。'}"
        if region.get("referenceId"):
            number = image_ids.index(region["referenceId"]) + 1
            line += f" 将第 {number} 张输入图的内容按第一张图中的摆放位置自然融入，处理边缘、光影和透视。"
        lines.append(line)
    return "\n".join(lines)


def cancel_job(db, owner, identifier):
    row = db.execute("SELECT * FROM generation_jobs WHERE id=? AND owner=?", (identifier, owner)).fetchone()
    if not row or row["status"] != "queued":
        raise CommercialError(409, "只有等待执行的任务可以取消。")
    finish_job(db, row, "cancelled")
    return job_detail(db, owner, identifier)


def delete_job(db, owner, identifier):
    row = db.execute("SELECT * FROM generation_jobs WHERE id=? AND owner=?", (identifier, owner)).fetchone()
    if not row:
        raise CommercialError(404, "任务不存在。")
    if row["hidden_at"] is None:
        if row["status"] == "queued":
            finish_job(db, row, "cancelled")
        db.execute("UPDATE generation_jobs SET hidden_at=? WHERE id=?", (now(), identifier))
    return job_detail(db, owner, identifier)


def generation_settings(db):
    return {"concurrency": db.execute("SELECT concurrency FROM generation_settings WHERE id=1").fetchone()[0],
            "maximum": MAX_GENERATION_CONCURRENCY}


def mask_image(source, selection):
    with Image.open(io.BytesIO(source)) as image:
        width, height = ImageOps.exif_transpose(image).size
    mask = Image.new("RGBA", (width, height), (255, 255, 255, 255))
    draw = ImageDraw.Draw(mask)
    for region in selection if isinstance(selection, list) else [selection]:
        left, top, right, bottom = pixel_rectangle(region, width, height)
        draw.rectangle((left, top, right - 1, bottom - 1), fill=(0, 0, 0, 0))
    buffer = io.BytesIO()
    mask.save(buffer, "PNG")
    return ("mask.png", "image/png", buffer.getvalue())


def pixel_rectangle(region, width, height):
    x, y, w, h = (region[key] / 100 for key in "xywh")
    left, top = min(width - 1, round(x * width)), min(height - 1, round(y * height))
    return left, top, min(width, max(left + 1, round((x + w) * width))), min(height, max(top + 1, round((y + h) * height)))


def prepare_region_edit(media, image_ids, regions):
    with Image.open(io.BytesIO(media[0][2])) as image:
        canvas = ImageOps.exif_transpose(image).convert("RGBA")
    for region in regions:
        reference_id = region.get("referenceId")
        if not reference_id:
            continue
        reference = media[image_ids.index(reference_id)][2]
        left, top, right, bottom = pixel_rectangle(region["referencePlacement"], *canvas.size)
        with Image.open(io.BytesIO(reference)) as image:
            image = ImageOps.exif_transpose(image).convert("RGBA")
            scale = min((right - left) / image.width, (bottom - top) / image.height)
            dimensions = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
            placed = image.resize(dimensions, Image.Resampling.LANCZOS)
        canvas.alpha_composite(placed, (left + (right - left - placed.width) // 2, top + (bottom - top - placed.height) // 2))
    buffer = io.BytesIO()
    canvas.save(buffer, "PNG")
    media[0] = ("edit-source.png", "image/png", buffer.getvalue())
    return mask_image(media[0][2], regions)


def archive_image(db, store, row, payload, data, submitted):
    output_format = payload.get("output", {}).get("format")
    if output_format == "svg":
        width, height = provider.svg_dimensions(data)
        extension, mime = ".svg", "image/svg+xml"
    else:
        with Image.open(io.BytesIO(data)) as image:
            width, height = image.size
            extension, mime = {"PNG": (".png", "image/png"), "JPEG": (".jpg", "image/jpeg"),
                               "WEBP": (".webp", "image/webp"), "GIF": (".gif", "image/gif")}[image.format]
            if output_format == "gif" and (image.format != "GIF" or not 2 <= image.n_frames <= 16):
                raise ValueError("Expected an animated GIF")
            image.verify()
    identifier = row["id"]
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", row["label"])[:95] + extension
    store.put(identifier, data)
    db.execute("INSERT INTO assets(id,user_id,name,mime,size,created) VALUES(?,?,?,?,?,?)",
               (identifier, row["owner"], name, mime, len(data), now()))
    db.execute("INSERT INTO asset_details(asset_id,job_id,parent_id,kind) VALUES(?,?,?,?)",
               (identifier, identifier, next(iter(payload["imageIds"]), None), row["scope"]))
    db.execute("UPDATE generation_jobs SET asset_id=?,submitted_size=?,width=?,height=? WHERE id=?",
               (identifier, submitted, width, height, row["id"]))
    finish_job(db, row, "succeeded")


def review_slide(database, model, payload, data, submitted):
    model_id = payload.get("context", {}).get("reviewModel")
    if not model_id:
        return data, submitted, None
    try:
        with database() as db:
            checker = provider.resolve(db, "chat", model_id, "vision")
        preview = io.BytesIO()
        with Image.open(io.BytesIO(data)) as image:
            image.thumbnail((1600, 900))
            image.convert("RGB").save(preview, "JPEG", quality=89)
        uri = "data:image/jpeg;base64," + base64.b64encode(preview.getvalue()).decode("ascii")
        instructions = ("你是 PPT 校对员。比较给定内容和页面，只判断明确的标题、数字、术语或逻辑关系错误。"
                        '仅输出 JSON 对象 {"ok":true,"issue":""} 或 {"ok":false,"issue":"具体错误"}。')
        result = provider.chat(checker, [{"role": "system", "content": instructions},
            {"role": "user", "content": [{"type": "text", "text": payload["prompt"]},
             {"type": "image_url", "image_url": {"url": uri}}]}])
        report = json.loads(result.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip())
        if report.get("ok") is True:
            return data, submitted, "模型已完成核对。"
        issue = report.get("issue")
        if report.get("ok") is not False or not isinstance(issue, str) or not issue.strip():
            return data, submitted, "自动核对结果无法识别，请人工检查。"
        correction = payload["prompt"][:11000] + "\n校对发现：" + issue.strip()[:500] + "。请修正该处。"
        with database() as db:
            permitted = check_image_policy(db, correction)
        improved, new_size = provider.generate(model, permitted, payload["size"])
        with Image.open(io.BytesIO(improved)) as candidate:
            candidate.verify()
        payload["actualPrompt"] = correction
        return improved, new_size, "已自动重出一版，请复核：" + issue.strip()[:200]
    except (provider.ProviderError, CommercialError, OSError, ValueError, AttributeError, Image.DecompressionBombError):
        return data, submitted, "自动核对或修复未完成，已保留原成稿供人工检查。"


def worker(database, store, shutdown, on_success=None):
    active = set()
    with ThreadPoolExecutor(max_workers=MAX_GENERATION_CONCURRENCY, thread_name_prefix="image-job") as pool:
        while not shutdown.is_set():
            for future in tuple(active):
                if future.done():
                    active.remove(future)
                    if future.exception():
                        logging.error("Unexpected generation worker error", exc_info=future.exception())
            try:
                with database() as db:
                    concurrency = generation_settings(db)["concurrency"]
                    capacity = max(0, concurrency - len(active))
                    queued = []
                    if capacity:
                        db.execute("BEGIN IMMEDIATE")
                        capacity = max(0, generation_settings(db)["concurrency"] - len(active))
                        queued = db.execute(
                            "SELECT * FROM generation_jobs WHERE status='queued' ORDER BY rowid LIMIT ?", (capacity,)
                        ).fetchall()
                        db.executemany("UPDATE generation_jobs SET status='running',updated=? WHERE id=?",
                                       ((now(), row["id"]) for row in queued))
                for row in queued:
                    active.add(pool.submit(run_job, database, store, row, on_success))
            except Exception:
                logging.exception("Unable to dispatch generation jobs")
            if active:
                wait(active, timeout=.35, return_when=FIRST_COMPLETED)
            else:
                shutdown.wait(.35)


def run_upscale(database, store, row, payload):
    method = payload["upscaleMethod"]
    target = tuple(map(int, payload["size"].split("x")))
    task_id = row["upstream_id"]
    with database() as db:
        upscale.ready(db, row["owner"], method)
        key = provider._connection_key(db, upscale.credential(db, row["owner"])) if method == "aliyun" else None
        if not task_id:
            owned_asset(db, row["owner"], payload["imageIds"][0], image_only=True, include_trash=True)
    if not task_id:
        source = upscale.source_image(store.read(payload["imageIds"][0]))
        if method == "local":
            data, model = upscale.local_image(source, target)
            note = "本机显存不足，已使用低显存超分模型。" if model != upscale.LOCAL_MODEL else None
            return data, None, note
        task_id = upscale.submit_aliyun(key, source, target)
        with database() as db:
            db.execute("UPDATE generation_jobs SET upstream_id=? WHERE id=?", (task_id, row["id"]))
    return upscale.wait_aliyun(key, task_id, target), task_id, None


def run_job(database, store, row, on_success):
    succeeded = False
    payload = {}
    try:
        payload = json.loads(row["payload"])
        if payload.get("upscaleMethod"):
            data, task_id, review = run_upscale(database, store, row, payload)
            receipt, submitted = {"requestId": task_id}, None
        else:
            data, submitted, receipt, review = run_generation(database, store, row, payload)
        try:
            with database() as db:
                db.execute("BEGIN IMMEDIATE")
                db.execute("UPDATE generation_jobs SET upstream_id=?,review=?,payload=? WHERE id=?",
                           (receipt.get("requestId"), review, json.dumps(payload, ensure_ascii=False), row["id"]))
                archive_image(db, store, row, payload, data, submitted)
            succeeded = True
        except (OSError, ValueError, KeyError) as error:
            if payload.get("upscaleMethod") == "local":
                raise CommercialError(500, "本地放大完成，但未能保存成品。") from error
            raise provider.ProviderError(502, "已收到上游结果，归档未完成，请核对。", uncertain=True) from error
    except (provider.ProviderError, CommercialError, OSError) as error:
        with database() as db:
            db.execute("BEGIN IMMEDIATE")
            uncertain = getattr(error, "uncertain", False) or bool(row["upstream_id"] and getattr(error, "request_id", None) is None)
            status = "unknown" if uncertain else "failed"
            finish_job(db, row, status, str(error) if not isinstance(error, OSError) else "无法读取素材文件。",
                       getattr(error, "request_id", None))
    except Exception:
        logging.exception("Generation job %s could not complete", row["id"])
        with database() as db:
            db.execute("BEGIN IMMEDIATE")
            if payload.get("upscaleMethod") == "local":
                finish_job(db, row, "failed", "本地放大中断，未保存成品。")
            else:
                finish_job(db, row, "unknown", "任务异常中止，请核对上游结果。")
    finally:
        with _preview_lock:
            _previews.pop(row["id"], None)

    if succeeded and on_success is not None:
        on_success(database, store, row["id"])


def run_generation(database, store, row, payload):
    with database() as db:
        regions = payload.get("regions")
        prompt = check_image_policy(db, payload.get("actualPrompt", payload["prompt"]))
        model = provider.resolve(db, "image", row["model_id"], image_capability(payload["imageIds"], regions or payload["mask"]))
        if model["model"] != row["provider_model"]:
            raise CommercialError(409, "模型配置已变更，请重新提交。")
        check_image_count(model, payload["imageIds"])
        check_generation_output(model, payload.get("output"))
        images = [owned_asset(db, row["owner"], key, True, True) for key in payload["imageIds"]]
    media = [(item["name"], item["mime"], store.read(item["id"])) for item in images]
    try:
        mask = (prepare_region_edit(media, payload["imageIds"], regions) if regions
                else mask_image(media[0][2], payload["mask"]) if payload["mask"] else None)
    except (OSError, ValueError, Image.DecompressionBombError) as error:
        raise CommercialError(400, "无法处理选区所用的图片，请重新上传。") from error
    receipt = {}
    output = payload.get("output")
    derived = output and output.get("method", "native") != "native"
    request_prompt, request_size = formats.raster_request(prompt, payload["size"], output) if derived else (prompt, payload["size"])
    options = {"output": output} if output and not derived else {}
    context = payload.get("context", {})
    full_result = derived or context.get("regenerate") or context.get("phase") == "redo"
    data, submitted = provider.generate(model, request_prompt, request_size, media, mask, receipt=receipt,
                                        on_preview=None if full_result else lambda preview: _publish_job_preview(row["id"], preview), **options)
    if derived:
        try:
            data = formats.finish_raster(data, payload["size"], output, metadata=payload)
            if output["format"] == "svg":
                provider.svg_dimensions(data)
        except (OSError, ValueError, RuntimeError, ImportError, Image.DecompressionBombError) as error:
            raise provider.ProviderError(502, "上游已出图，但本地转换未完成。请查看原任务，系统没有自动重试。",
                                         uncertain=True, request_id=receipt.get("requestId")) from error
    data, submitted, review = review_slide(database, model, payload, data, submitted)
    return data, submitted, receipt, review


def conversations(db, owner, method, body=None):
    if method == "GET":
        rows = db.execute("""SELECT id,title,updated FROM conversations
            WHERE owner=? AND length(id)=32
            ORDER BY updated DESC,rowid DESC LIMIT 100""", (owner,))
        return {"conversations": [dict(row) for row in rows]}
    identifier = uuid.uuid4().hex
    title = text(body.get("title", "新对话"), "会话名称", 100)
    db.execute("INSERT INTO conversations VALUES(?,?,?,?)", (identifier, owner, title, now()))
    return {"conversation": {"id": identifier, "title": title}}


def owned_conversation(db, owner, identifier):
    row = db.execute("SELECT id,title,updated FROM conversations WHERE id=? AND owner=?", (identifier, owner)).fetchone()
    if not row:
        raise CommercialError(404, "对话不存在。")
    return row


def conversation(db, owner, identifier, method):
    row = owned_conversation(db, owner, identifier)
    turns = db.execute("SELECT * FROM chat_turns WHERE conversation=? ORDER BY id", (identifier,)).fetchall()
    if method == "DELETE":
        if any(turn["status"] in ("running", "unknown") for turn in turns):
            raise CommercialError(409, "请等待对话结束或核对待确认请求。")
        db.execute("DELETE FROM conversations WHERE id=?", (identifier,))
        return {"ok": True}
    messages = []
    for turn in turns:
        user_message = {"role": "user", "text": turn["user_text"], "created": turn["created"], "turnId": turn["id"]}
        if turn["asset_ids"]:
            user_message["assetIds"] = json.loads(turn["asset_ids"])
        messages.append(user_message)
        if turn["reply"] or turn["web_search"]:
            message = {"role": "assistant", "text": turn["reply"], "modelName": turn["model_name"],
                       "created": turn["created"], "turnId": turn["id"]}
            if turn["web_search"]:
                message["webSearch"] = json.loads(turn["web_search"])
            messages.append(message)
    return {"conversation": dict(row), "messages": messages}


def start_chat(db, owner, identifier, body, *, system=None, max_output=4096, label="AI 对话",
               include_history=False, extra_input=0, asset_ids=None, capability="text"):
    row = owned_conversation(db, owner, identifier)
    prompt = text(body.get("text"), "消息", 12000)
    request = text(body.get("requestId"), "请求号", 80)
    existing = db.execute("SELECT * FROM chat_turns WHERE conversation=? AND request_id=?", (identifier, request)).fetchone()
    if existing:
        if existing["status"] != "succeeded" and not (existing["status"] == "unknown" and existing["reply"]):
            raise CommercialError(409, "这条消息已提交，请刷新对话核对结果。")
        return None, existing["reply"], existing
    if db.execute("SELECT 1 FROM chat_turns WHERE conversation=? AND status='running'", (identifier,)).fetchone():
        raise CommercialError(409, "请先等待上一条消息完成。")
    model = provider.resolve(db, "chat", body.get("modelId"), capability)
    rates = model["tokenRates"]
    if not rates or body.get("tokenRates") != rates:
        raise CommercialError(409, "语言模型价格已更新，请重新确认后提交。")
    messages = []
    if system is not None:
        messages.append({"role": "system", "content": system})
    if system is None or include_history:
        previous = db.execute("""SELECT user_text,reply FROM chat_turns WHERE conversation=?
            AND (status='succeeded' OR (status='unknown' AND reply<>'')) ORDER BY id DESC LIMIT 16""", (identifier,)).fetchall()
        for turn in reversed(previous):
            messages.extend([{"role": "user", "content": turn["user_text"]}, {"role": "assistant", "content": turn["reply"]}])
    messages.append({"role": "user", "content": prompt})
    # UTF-8 bytes plus message framing provide a conservative budget for text input.
    input_budget = 64 + extra_input + sum(16 + len(message["content"].encode("utf-8")) for message in messages)
    budget = input_budget * rates["input"] + max_output * rates["output"]
    if budget:
        carry = db.execute("SELECT remainder FROM chat_billing WHERE owner=?", (owner,)).fetchone()
        # A balance migrated from hundredths can contain whole units at the new precision.
        if carry and carry["remainder"] >= provider.TOKEN_UNIT:
            budget += carry["remainder"]
    reserve = (budget + provider.TOKEN_UNIT - 1) // provider.TOKEN_UNIT
    cursor = db.execute("""INSERT INTO chat_turns(conversation,request_id,user_text,model_name,price,status,created,token_rates,asset_ids)
        VALUES(?,?,?,?,?,'running',?,?,?)""",
        (identifier, request, prompt, model["name"], reserve, now(), json.dumps(rates), json.dumps(asset_ids) if asset_ids else None))
    turn_id = cursor.lastrowid
    change_points(db, owner, -reserve, "预留 · " + label, f"chat-reserve:{turn_id}")
    db.execute("UPDATE conversations SET updated=?,title=? WHERE id=?",
               (now(), prompt[:36] if row["title"] == "新对话" else row["title"], identifier))
    return model, messages, turn_id


def token_usage(value):
    if not isinstance(value, dict):
        return None
    inputs = value.get("input_tokens", value.get("prompt_tokens"))
    outputs = value.get("output_tokens", value.get("completion_tokens"))
    if any(type(number) is not int or not 0 <= number <= 100_000_000 for number in (inputs, outputs)):
        return None
    return {"input": inputs, "output": outputs}


def billing_view(turn):
    return {"status": turn["status"], "usage": json.loads(turn["token_usage"]) if turn["token_usage"] else None,
            "charged": turn["price"] if turn["status"] == "succeeded" else None}


def finish_chat(db, owner, turn_id, reply, status, receipt=None, label="AI 对话", *, reconcile=False):
    row = db.execute("SELECT * FROM chat_turns WHERE id=? AND status=?", (turn_id, "unknown" if reconcile else "running")).fetchone()
    if not row:
        raise CommercialError(409, "语言任务状态已变化，请刷新。")
    receipt = receipt or {}
    usage = token_usage(receipt.get("usage"))
    rates = json.loads(row["token_rates"]) if row["token_rates"] else None
    reserved = row["price"]
    charged = reserved
    if status == "failed":
        change_points(db, owner, reserved, "释放 · " + label, f"chat-release:{turn_id}")
    elif status == "succeeded":
        if usage is None and rates and any(rates.values()):
            status = "unknown"
        else:
            detail = label
            if rates:
                balance = db.execute("SELECT remainder FROM chat_billing WHERE owner=?", (owner,)).fetchone()
                remainder = balance["remainder"] if balance else 0
                total = sum(usage[key] * rates[key] for key in rates) if usage else 0
                charged = 0
                if total:
                    charged, remainder = divmod(total + remainder, provider.TOKEN_UNIT)
                if usage:
                    detail += f" · 输入 {usage['input']} / 输出 {usage['output']} Token"
            available = db.execute("SELECT points FROM users WHERE id=?", (owner,)).fetchone()["points"]
            if charged > reserved + available:
                status, charged = "unknown", reserved
            else:
                if rates:
                    db.execute("""INSERT INTO chat_billing(owner,remainder) VALUES(?,?)
                        ON CONFLICT(owner) DO UPDATE SET remainder=excluded.remainder""", (owner, remainder))
                change_points(db, owner, reserved - charged, "结算 · " + detail, f"chat-settle:{turn_id}")
    db.execute("""UPDATE chat_turns SET reply=?,status=?,price=?,token_usage=COALESCE(?,token_usage),
                  upstream_id=COALESCE(?,upstream_id) WHERE id=?""",
               (reply, status, charged, json.dumps(usage) if usage else None, receipt.get("requestId"), turn_id))
    return billing_view(db.execute("SELECT * FROM chat_turns WHERE id=?", (turn_id,)).fetchone())


def resolve_unknown_chat(db, turn, owner, usage=None):
    if usage is not None and (not turn["token_rates"] or not token_usage(usage)):
        raise CommercialError(400, "请录入服务商确认的输入和输出 Token 数。")
    result = finish_chat(db, owner, turn["id"], turn["reply"], "succeeded" if usage is not None else "failed",
                         {"usage": usage}, reconcile=True)
    if result["status"] == "unknown":
        raise CommercialError(409, "可用积分不足，暂无法完成结算。")
    return result


def workbench_conversation(owner, label, session_id=""):
    key = f"{owner}:{label}"
    if session_id:
        key += f":{session_id}"
    return "workbench-" + hashlib.sha256(key.encode()).hexdigest()[:32]


def chat_task(database, owner, body, message, system, label, parse=None, *, max_output=4096, emit=None, ready=None,
              research=None, research_id="", on_evidence=None, session_id="", image_uri=None, visual_references=()):
    request = text(body.get("requestId"), "请求号", 80)
    identifier = workbench_conversation(owner, label, session_id)
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        db.execute("INSERT OR IGNORE INTO conversations VALUES(?,?,?,?)", (identifier, owner, label, now()))
        extra_input = (web_search.MAX_CONTEXT_BYTES if research else 0) + (2048 if image_uri else 0)
        if visual_references:
            extra_input += min(len(visual_references[1]), ecommerce.MAX_VISION_REFERENCES) * ecommerce.VISION_TOKEN_BUDGET
        model, previous, turn = start_chat(db, owner, identifier, {**body, "requestId": request, "text": message},
                                           system=system, max_output=max_output, label=label,
                                           extra_input=extra_input, capability="vision" if image_uri else "text")
    if ready is not None:
        ready()
    if not model:
        if emit is not None:
            emit(previous)
        evidence = json.loads(turn["web_search"]) if turn["web_search"] else None
        if evidence:
            evidence.pop("researchId", None)
        return (parse(previous) if parse else previous), billing_view(turn), evidence, turn["id"]
    receipt = {}
    chunks = []
    evidence = None
    try:
        if image_uri:
            previous[-1]["content"] = [{"type": "text", "text": message},
                                       {"type": "image_url", "image_url": {"url": image_uri}}]
        if research:
            evidence = web_search.bounded_evidence(research())
            with database() as db:
                db.execute("UPDATE chat_turns SET web_search=? WHERE id=?",
                           (json.dumps({**evidence, "researchId": research_id}, ensure_ascii=False), turn))
            previous = web_search.add_context(previous, evidence, web_search.PPT_INSTRUCTION)
            if on_evidence is not None:
                on_evidence(evidence)
        if visual_references and "vision" in model["capabilities"]:
            store, references = visual_references
            previous = ecommerce.attach_reference_images(previous, store, references)
        streaming = emit is not None and "stream" in model["capabilities"]
        reply = provider.chat(model, previous, stream=streaming, receipt=receipt, max_output=max_output)
        if streaming:
            with closing(reply):
                for chunk in reply:
                    chunks.append(chunk)
                    emit(chunk)
            reply = "".join(chunks)
        elif emit is not None:
            emit(reply)
    except provider.ProviderError as error:
        with database() as db:
            db.execute("BEGIN IMMEDIATE")
            receipt.setdefault("requestId", error.request_id)
            finish_chat(db, owner, turn, "", "unknown" if error.uncertain else "failed", receipt, label)
        raise
    except Exception:
        with database() as db:
            db.execute("BEGIN IMMEDIATE")
            finish_chat(db, owner, turn, "", "unknown", receipt, label)
        raise
    try:
        result = parse(reply) if parse else reply
    except CommercialError:
        with database() as db:
            db.execute("BEGIN IMMEDIATE")
            finish_chat(db, owner, turn, "", "failed", receipt, label)
        raise
    with database() as db:
        db.execute("BEGIN IMMEDIATE")
        billing = finish_chat(db, owner, turn, reply, "succeeded", receipt, label)
    return result, billing, evidence, turn


POSTER_FORMATS = frozenset("main story feed portrait square product landscape wide cover banner header print".split())


def poster_reference_assets(db, owner, body):
    identifiers = body.get("assetIds", [])
    if (not isinstance(identifiers, list) or len(identifiers) > 4
            or any(not isinstance(item, str) for item in identifiers) or len(set(identifiers)) != len(identifiers)):
        raise CommercialError(400, "海报参考图格式无效。")
    product = body.get("productId")
    if product is not None and product not in identifiers:
        raise CommercialError(400, "产品主图应包含在参考素材中。")
    return [(f"{index}（{'产品主图' if item == product else '风格参考' if 'productId' in body else '用途待确认'}）",
             owned_asset(db, owner, item, image_only=True)) for index, item in enumerate(identifiers, 1)]


def poster_advisor_message(db, owner, body, *, references=None):
    data = {
        "本轮需求": text(body.get("message", ""), "本轮需求", 2000, 0),
        "已确认沟通": text(body.get("transcript", ""), "沟通记录", 5000, 0),
        "活动标题": text(body.get("title", ""), "活动标题", 80, 0),
        "活动副标题": text(body.get("subtitle", ""), "活动副标题", 160, 0),
        "活动时间": text(body.get("date", ""), "活动时间", 32, 0),
        "画面描述": text(body.get("prompt", ""), "画面描述", 3000, 0),
    }
    if not (data["本轮需求"] or data["已确认沟通"]):
        raise CommercialError(400, "请先描述海报用途。")
    if references is None:
        references = poster_reference_assets(db, owner, body)
    data["图片附件"] = [{"用途": role, "名称": asset["name"]} for role, asset in references]
    formats = body.get("formats", [])
    if not isinstance(formats, list) or len(formats) > 12 or any(not isinstance(item, str) or item not in POSTER_FORMATS for item in formats):
        raise CommercialError(400, "海报尺寸格式无效。")
    data["当前勾选"] = formats
    catalog = body.get("catalog", [])
    if not isinstance(catalog, list) or len(catalog) > 12:
        raise CommercialError(400, "海报尺寸目录无效。")
    data["尺寸目录"] = [
        {"id": item["id"], "名称": text(item.get("label"), "尺寸名称", 24), "像素": text(item.get("size"), "尺寸", 24)}
        for item in catalog if isinstance(item, dict) and isinstance(item.get("id"), str) and item["id"] in POSTER_FORMATS
    ]
    return json.dumps(data, ensure_ascii=False)


def poster_advisor_result(reply):
    try:
        value = json.loads(re.sub(r"^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$", "", reply.strip(), flags=re.IGNORECASE))
        if not isinstance(value, dict) or not isinstance(value.get("formats"), list):
            raise ValueError
        formats = list(dict.fromkeys(item for item in value["formats"] if isinstance(item, str) and item in POSTER_FORMATS))
        result = {field: text(value.get(field, ""), field, limit, int(field == "prompt"))
                  for field, limit in (("title", 30), ("subtitle", 40), ("date", 32), ("prompt", 2000))}
        return {**result, "formats": formats}
    except (ValueError, TypeError, CommercialError) as error:
        raise CommercialError(422, "AI 返回的海报方案无法识别，请重新整理或更换模型。") from error


def outline_result(reply):
    try:
        cleaned = reply.strip()
        if cleaned.startswith("```"):
            cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.IGNORECASE)
        pages = json.loads(cleaned)
        if not isinstance(pages, list) or not 1 <= len(pages) <= 12:
            raise ValueError
        return [[text(item["title"], "页标题", 120), text(item["detail"], "页内容", 2000)] for item in pages]
    except (ValueError, KeyError, TypeError, CommercialError) as error:
        raise CommercialError(422, "语言模型返回的大纲格式无法识别，请调整需求或换模型。") from error


def export_ppt(db, store, owner, payload, *, image_only_pages=None, review_pages=None):
    pages = payload.get("slides")
    if not isinstance(pages, list) or not 1 <= len(pages) <= 24:
        raise CommercialError(400, "请选择 1 至 24 张幻灯片。")
    slides = []
    for page in pages:
        if not isinstance(page, dict):
            raise CommercialError(400, "幻灯片参数格式无效。")
        asset = owned_asset(db, owner, page.get("assetId"), True)
        slides.append({"image": store.read(asset["id"]), "title": page.get("title", ""),
                       "textboxes": page.get("textboxes", []), "preserveImage": page.get("preserveImage") is True})
    return documents.export_presentation(slides, auto=payload.get("editable") is True and payload.get("auto") is True,
                                         image_only_pages=image_only_pages, review_pages=review_pages)


def disposition(name):
    return "attachment; filename*=UTF-8''" + quote(name, safe="")
