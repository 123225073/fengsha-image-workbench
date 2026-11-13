"""Named creative projects and published template revisions."""

import json
import re
import time
import uuid

from commercial_documents import MAX_PPT_ATTACHMENTS


SCOPES = {"image", "poster", "ppt"}
ASSET_ID = re.compile(r"[a-f0-9]{32}\Z")
PPT_SESSION_ID = re.compile(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\Z")
SCOPE_UPLOADS = {
    "image": {"image", "reference", "generation-reference",
              *(f"{prefix}{index}" for prefix in ("reference", "generation-reference") for index in range(2, 17))},
    "poster": {"logo", "qr", "poster-product", "poster-reference", "poster-reference2", "poster-reference3"},
    "ppt": {"ppt", *(f"ppt{index}" for index in range(2, MAX_PPT_ATTACHMENTS + 1))},
}
TEMPLATE_FIELDS = {
    "image": {"prompt": 3000},
    "image-edit": {"prompt": 3000},
    "poster": {"title": 80, "subtitle": 160, "date": 32, "prompt": 3000},
    "ppt": {"brief": 6000},
    "chat": {"prompt": 12000},
}
EDIT_TOOLS = {"edit", "mask", "background", "expand", "crop", "cutout", "upscale", "extract"}
TEMPLATE_OPTIONS = {
    "image": {
        "tool": {"text", "image", "reference", "batch"} | EDIT_TOOLS,
        "ratio": {"1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9", "5:4", "4:5", "7:5", "5:7", "2:1", "1:2", "9:21"},
        "resolution": {"512 px", "1K", "1080 px", "2K", "3K", "3840 px", "4K"},
        "format": {"still", "gif", "svg"},
    },
    "image-edit": {"tool": EDIT_TOOLS},
    "poster": {"preset": {"auto", "campaign", "studio", "lifestyle", "detail"}},
    "ppt": {
        "level": {"简报", "标准", "详细"},
        "style": {"商务深蓝", "科技", "极简"},
    },
    "chat": {},
}


class ProjectError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def setup(db):
    db.executescript("""
        CREATE TABLE IF NOT EXISTS creative_templates (
            id TEXT PRIMARY KEY,
            scope TEXT NOT NULL,
            revision INTEGER NOT NULL,
            published_revision INTEGER,
            archived INTEGER NOT NULL DEFAULT 0,
            updated INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS creative_template_versions (
            template_id TEXT NOT NULL REFERENCES creative_templates(id),
            revision INTEGER NOT NULL,
            name TEXT NOT NULL,
            description TEXT NOT NULL,
            settings TEXT NOT NULL,
            actor INTEGER NOT NULL REFERENCES users(id),
            created INTEGER NOT NULL,
            PRIMARY KEY (template_id, revision)
        );
        CREATE TABLE IF NOT EXISTS creative_projects (
            id TEXT PRIMARY KEY,
            owner INTEGER NOT NULL REFERENCES users(id),
            name TEXT NOT NULL,
            scope TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 1,
            archived INTEGER NOT NULL DEFAULT 0,
            template_id TEXT,
            template_revision INTEGER,
            workspace TEXT NOT NULL,
            created INTEGER NOT NULL,
            updated INTEGER NOT NULL,
            FOREIGN KEY (template_id, template_revision)
                REFERENCES creative_template_versions(template_id, revision)
        );
        CREATE INDEX IF NOT EXISTS creative_projects_owner
            ON creative_projects (owner, archived, updated);
    """)
    columns = {column["name"] for column in db.execute("PRAGMA table_info(creative_projects)")}
    if "description" not in columns:
        db.execute("ALTER TABLE creative_projects ADD COLUMN description TEXT NOT NULL DEFAULT ''")
    if "deleted" not in columns:
        db.execute("ALTER TABLE creative_projects ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0")
    db.execute("""CREATE TABLE IF NOT EXISTS creative_project_chats (
        project_id TEXT NOT NULL REFERENCES creative_projects(id),
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE
    )""")
    db.execute("""CREATE TABLE IF NOT EXISTS creative_project_assets (
        project_id TEXT NOT NULL REFERENCES creative_projects(id),
        asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        PRIMARY KEY(project_id,asset_id)
    )""")
    db.execute("""CREATE TABLE IF NOT EXISTS ppt_workspace_sessions (
        owner INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL,
        id TEXT NOT NULL,
        title TEXT NOT NULL,
        workspace TEXT NOT NULL,
        updated INTEGER NOT NULL,
        PRIMARY KEY(owner,project_id,id)
    )""")


def _now():
    return int(time.time())


def _text(value, label, maximum, minimum=1):
    if not isinstance(value, str) or not minimum <= len(value.strip()) <= maximum:
        raise ProjectError(400, f"{label}须为 {minimum} 至 {maximum} 个字符。")
    return value.strip()


def _json(value, maximum):
    try:
        result = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    except (ValueError, TypeError, RecursionError):
        raise ProjectError(400, "工作区数据格式无效。") from None
    if len(result.encode("utf-8")) > maximum:
        raise ProjectError(413, "工作区内容过多。")
    return result


def _workspace(db, owner, scope, identifier, value):
    if not isinstance(value, dict) or set(value) - {"document", "uploads"}:
        raise ProjectError(400, "项目工作区格式无效。")
    document = value.get("document", {})
    uploads = value.get("uploads", {})
    if not isinstance(document, dict) or not isinstance(uploads, dict) or len(uploads) > 800:
        raise ProjectError(400, "项目工作区格式无效。")
    for key, asset in uploads.items():
        allowed = key in SCOPE_UPLOADS[scope] or (scope == "image" and re.fullmatch(r"local:[a-f0-9-]{32,36}", key))
        if not allowed or not isinstance(asset, str) or not ASSET_ID.fullmatch(asset):
            raise ProjectError(400, "项目素材格式无效。")
    ids = set(uploads.values())
    if ids:
        placeholders = ",".join("?" for _ in ids)
        count = db.execute(f"SELECT COUNT(*) FROM assets WHERE user_id=? AND id IN ({placeholders})", (owner, *ids)).fetchone()[0]
        if count != len(ids):
            raise ProjectError(404, "项目素材不存在或无权使用。")
    document_id = document.get("documentId") if scope == "poster" else None
    if not isinstance(document_id, str) or not (ASSET_ID.fullmatch(document_id) or PPT_SESSION_ID.fullmatch(document_id)):
        document_id = identifier
    return _json({"document": {**document, "documentId": document_id}, "uploads": uploads}, 650000)


def _project(db, owner, identifier):
    row = db.execute("SELECT * FROM creative_projects WHERE id=? AND owner=?", (identifier, owner)).fetchone()
    if not row:
        raise ProjectError(404, "未找到项目。")
    return row


def _project_workspaces(row):
    saved = json.loads(row["workspace"])
    if "workspaces" in saved:
        return saved["workspaces"]
    return {row["scope"]: saved}


def _project_view(row, full=False):
    workspaces = _project_workspaces(row)
    result = {
        "id": row["id"], "name": row["name"], "scope": row["scope"], "revision": row["revision"],
        "archived": bool(row["archived"]), "created": row["created"], "updated": row["updated"],
        "templateId": row["template_id"], "templateRevision": row["template_revision"],
        "description": row["description"], "deleted": bool(row["deleted"]), "scopes": list(workspaces),
    }
    if full:
        result["workspaces"] = workspaces
        result["workspace"] = workspaces.get(row["scope"], {"document": {"documentId": row["id"]}, "uploads": {}})
    return result


def _merge_workspaces(db, owner, identifier, existing, updates, *, new=False):
    if not isinstance(updates, dict) or set(updates) - SCOPES:
        raise ProjectError(400, "项目工作台格式无效。")
    result = dict(existing)
    for scope, workspace in updates.items():
        if new and isinstance(workspace, dict) and isinstance(workspace.get("document"), dict):
            workspace = {**workspace, "document": {key: value for key, value in workspace["document"].items()
                                                  if key != "tracked"}}
        result[scope] = json.loads(_workspace(db, owner, scope, identifier, workspace))
    return _json({"workspaces": result}, 1951000)


def active_project(db, owner, identifier):
    row = _project(db, owner, identifier)
    if row["archived"] or row["deleted"]:
        raise ProjectError(409, "请恢复项目后再编辑。")
    return row


def ppt_session_scope(db, owner, project_id):
    if not isinstance(project_id, str) or (project_id and not ASSET_ID.fullmatch(project_id)):
        raise ProjectError(400, "PPT 项目编号不正确。")
    if project_id:
        active_project(db, owner, project_id)
    return project_id


def ppt_session(db, owner, project_id, body=None):
    project_id = ppt_session_scope(db, owner, project_id)
    opened = None
    if body is not None:
        if not isinstance(body, dict):
            raise ProjectError(400, "PPT 对话资料格式不正确。")
        target = body.get("open", "")
        if not isinstance(target, str) or (target and not PPT_SESSION_ID.fullmatch(target)):
            raise ProjectError(400, "PPT 对话编号不正确。")
        if target:
            row = db.execute("SELECT workspace FROM ppt_workspace_sessions WHERE owner=? AND project_id=? AND id=?",
                             (owner, project_id, target)).fetchone()
            if not row:
                raise ProjectError(404, "找不到该 PPT 对话。")
            opened = json.loads(row["workspace"])
        archive = body.get("archive")
        if archive is not None:
            if not isinstance(archive, dict) or not isinstance(archive.get("id"), str) or not PPT_SESSION_ID.fullmatch(archive["id"]):
                raise ProjectError(400, "PPT 对话编号不正确。")
            title = _text(archive.get("title"), "PPT 对话标题", 80)
            document = archive.get("document")
            if not isinstance(document, dict):
                raise ProjectError(400, "PPT 对话资料格式不正确。")
            workspace = _workspace(db, owner, "ppt", project_id,
                                   {"document": {**document, "draftId": archive["id"]}, "uploads": archive.get("uploads", {})})
            db.execute("""INSERT INTO ppt_workspace_sessions(owner,project_id,id,title,workspace,updated) VALUES(?,?,?,?,?,?)
                ON CONFLICT(owner,project_id,id) DO UPDATE
                SET title=excluded.title,workspace=excluded.workspace,updated=excluded.updated""",
                (owner, project_id, archive["id"], title, workspace, _now()))
    items = db.execute("""SELECT id,title FROM ppt_workspace_sessions WHERE owner=? AND project_id=?
        ORDER BY updated DESC,rowid DESC""", (owner, project_id))
    return {"sessions": [dict(item) for item in items], "opened": opened}


def project_assets(db, owner, identifier):
    row = _project(db, owner, identifier)
    assets = set()

    def collect(value):
        if isinstance(value, str) and ASSET_ID.fullmatch(value):
            assets.add(value)
        elif isinstance(value, list):
            for item in value:
                collect(item)
        elif isinstance(value, dict):
            for item in value.values():
                collect(item)

    collect(_project_workspaces(row).get("ppt", {}))
    for session in db.execute(
        "SELECT workspace FROM ppt_workspace_sessions WHERE owner=? AND project_id=?", (owner, identifier)
    ):
        collect(json.loads(session["workspace"]))
    related = db.execute("""SELECT d.asset_id FROM asset_details d
        JOIN generation_jobs j ON j.id=d.job_id
        WHERE j.owner=? AND j.scope='ppt' AND json_extract(j.payload,'$.context.documentId')=?""",
        (owner, identifier))
    assets.update(item["asset_id"] for item in related)
    linked = {item["asset_id"] for item in db.execute(
        "SELECT asset_id FROM creative_project_assets WHERE project_id=?", (identifier,))}
    owned = {item["id"] for item in db.execute("""SELECT a.id FROM assets a
        LEFT JOIN asset_details d ON d.asset_id=a.id
        WHERE a.user_id=? AND COALESCE(d.trashed,0)=0""", (owner,))}
    return {"assetIds": sorted((assets | linked) & owned), "linkedIds": sorted(linked & owned)}


def update_project_assets(db, owner, identifier, body, method):
    active_project(db, owner, identifier)
    ids = body.get("assetIds")
    if not isinstance(ids, list) or not 1 <= len(ids) <= 100 or any(
        not isinstance(item, str) or not ASSET_ID.fullmatch(item) for item in ids
    ):
        raise ProjectError(400, "请选择 1 至 100 个素材。")
    ids = list(dict.fromkeys(ids))
    if method == "POST":
        placeholders = ",".join("?" for _ in ids)
        count = db.execute(f"""SELECT COUNT(*) FROM assets a LEFT JOIN asset_details d ON d.asset_id=a.id
            WHERE a.user_id=? AND COALESCE(d.trashed,0)=0 AND a.id IN ({placeholders})""", (owner, *ids)).fetchone()[0]
        if count != len(ids):
            raise ProjectError(404, "素材不存在或无权使用。")
        db.executemany("INSERT OR IGNORE INTO creative_project_assets VALUES (?,?)", ((identifier, item) for item in ids))
    else:
        db.executemany("DELETE FROM creative_project_assets WHERE project_id=? AND asset_id=?", ((identifier, item) for item in ids))
    return project_assets(db, owner, identifier)


def _create_project(db, owner, body):
    identifier = uuid.uuid4().hex
    template_id = body.get("templateId")
    template_revision = None
    name = _text(body.get("name"), "项目名称", 80)
    description = _text(body.get("description", ""), "项目说明", 500, 0)
    if template_id:
        template = _template(db, template_id, public=True)
        template_revision = template["version"]
        if body.get("templateRevision") != template_revision:
            raise ProjectError(409, "模板版本已更新，请刷新后重新选择。")
        if template["scope"] != "ppt":
            raise ProjectError(400, "请在对应工作台使用此模板。")
        updates = {"ppt": {"document": json.loads(template["settings"])}}
    else:
        if body.get("scope", "ppt") != "ppt":
            raise ProjectError(400, "项目仅用于 PPT。")
        updates = body.get("workspaces", {"ppt": body.get("workspace", {})})
        if not isinstance(updates, dict) or set(updates) - {"ppt"}:
            raise ProjectError(400, "项目仅用于 PPT。")
        updates = updates or {"ppt": {}}
    data = _merge_workspaces(db, owner, identifier, {}, updates, new=True)
    now = _now()
    db.execute("""INSERT INTO creative_projects
        (id,owner,name,scope,template_id,template_revision,workspace,created,updated,description)
        VALUES(?,?,?,?,?,?,?,?,?,?)""", (identifier, owner, name, "ppt", template_id or None, template_revision, data, now, now, description))
    return {"project": _project_view(_project(db, owner, identifier), True)}


def _update_project(db, owner, identifier, body):
    row = _project(db, owner, identifier)
    revision = body.get("revision")
    if type(revision) is not int or revision != row["revision"]:
        raise ProjectError(409, "项目已在其他页面更新，请重新打开后继续。")
    archived = body.get("archived", bool(row["archived"]))
    if type(archived) is not bool:
        raise ProjectError(400, "项目归档状态无效。")
    deleted = body.get("deleted", bool(row["deleted"]))
    if type(deleted) is not bool:
        raise ProjectError(400, "项目删除状态无效。")
    name = _text(body.get("name", row["name"]), "项目名称", 80)
    description = _text(body.get("description", row["description"]), "项目说明", 500, 0)
    workspace = row["workspace"]
    if "workspace" in body or "workspaces" in body:
        if archived or deleted or row["archived"] or row["deleted"]:
            raise ProjectError(409, "请恢复归档项目后再编辑。")
        updates = body.get("workspaces", {"ppt": body.get("workspace")})
        if not isinstance(updates, dict) or set(updates) - {"ppt"}:
            raise ProjectError(400, "项目仅用于 PPT。")
        workspace = _merge_workspaces(db, owner, identifier, _project_workspaces(row), updates)
    changed = db.execute("""UPDATE creative_projects
        SET name=?,description=?,archived=?,deleted=?,workspace=?,revision=revision+1,updated=?
        WHERE id=? AND revision=?""",
        (name, description, archived, deleted, workspace, _now(), identifier, revision))
    if not changed.rowcount:
        raise ProjectError(409, "项目已在其他页面更新，请重新打开后继续。")
    return {"project": _project_view(_project(db, owner, identifier), True)}


def poster_history(db, owner):
    rows = db.execute("""SELECT * FROM creative_projects
        WHERE owner=? AND scope='poster' AND archived=0 AND deleted=0
        ORDER BY updated DESC, rowid DESC""", (owner,))
    return [_project_view(row) for row in rows]


def switch_poster(db, owner, workspace, target):
    if not isinstance(target, str) or (target and not ASSET_ID.fullmatch(target)):
        raise ProjectError(400, "海报项目编号不正确。")
    opened = active_project(db, owner, target) if target else None
    if opened and opened["scope"] != "poster":
        raise ProjectError(404, "未找到海报项目。")
    current = dict(workspace.get("poster", {}))
    current_id = current.pop("projectId", "")
    if target and target == current_id:
        return workspace
    uploads = dict(workspace.get("uploads", {}))
    poster_uploads = {key: uploads.pop(key) for key in SCOPE_UPLOADS["poster"] if key in uploads}
    content = next((value.strip() for key in ("title", "prompt", "subtitle", "message")
                    if isinstance(value := current.get(key), str) and value.strip()), "")
    if current_id or content or poster_uploads or any(
        current.get(key) for key in ("date", "discussion", "advisorHistory", "proposal", "visual", "visuals", "tracked", "savedAssets")
    ):
        if current_id and (not isinstance(current_id, str) or not ASSET_ID.fullmatch(current_id)):
            raise ProjectError(400, "当前海报项目编号不正确。")
        row = active_project(db, owner, current_id) if current_id else None
        if row and row["scope"] != "poster":
            raise ProjectError(404, "未找到海报项目。")
        identifier = current_id or uuid.uuid4().hex
        # A removed library asset should not block starting a new product.
        poster_uploads = {key: value for key, value in poster_uploads.items() if isinstance(value, str) and
                          db.execute("SELECT 1 FROM assets WHERE user_id=? AND id=?", (owner, value)).fetchone()}
        saved = _merge_workspaces(db, owner, identifier, {}, {"poster": {"document": current, "uploads": poster_uploads}})
        now = _now()
        if row:
            db.execute("""UPDATE creative_projects SET workspace=?, updated=?, revision=revision+1
                          WHERE owner=? AND id=?""", (saved, now, owner, identifier))
        else:
            name = " ".join(content.split())[:60] or "海报创作 " + time.strftime("%m-%d %H:%M")
            db.execute("""INSERT INTO creative_projects(id,owner,name,scope,workspace,created,updated)
                          VALUES(?,?,?,'poster',?,?,?)""", (identifier, owner, name, saved, now, now))
    if opened:
        draft = _project_workspaces(opened)["poster"]
        current = {**draft["document"], "projectId": target}
        uploads.update(draft["uploads"])
    else:
        current = {}
    return {**workspace, "poster": current, "uploads": uploads}


def _template_query(public):
    version = "t.published_revision" if public else "t.revision"
    return f"""SELECT t.*,v.name,v.description,v.settings,v.revision AS version,v.created
        FROM creative_templates t JOIN creative_template_versions v
        ON v.template_id=t.id AND v.revision={version}"""


def _template(db, identifier, public=False):
    if not isinstance(identifier, str) or not ASSET_ID.fullmatch(identifier):
        raise ProjectError(404, "未找到模板。")
    statement = _template_query(public) + " WHERE t.id=?"
    if public:
        statement += " AND t.archived=0"
    row = db.execute(statement, (identifier,)).fetchone()
    if not row:
        raise ProjectError(404, "未找到可用模板。")
    return row


def _template_view(row, admin=False):
    result = {
        "id": row["id"], "scope": row["scope"], "name": row["name"], "description": row["description"],
        "revision": row["version"], "settings": json.loads(row["settings"]), "updated": row["updated"],
    }
    if admin:
        result.update({"publishedRevision": row["published_revision"], "archived": bool(row["archived"])})
    return result


def _template_settings(scope, value):
    if not isinstance(value, dict) or set(value) - (TEMPLATE_FIELDS[scope].keys() | TEMPLATE_OPTIONS[scope].keys()):
        raise ProjectError(400, "模板设置无效。")
    fields = {}
    for key, content in value.items():
        if key in TEMPLATE_FIELDS[scope]:
            fields[key] = _text(content, "模板内容", TEMPLATE_FIELDS[scope][key], 0)
        elif not isinstance(content, str) or content not in TEMPLATE_OPTIONS[scope][key]:
            raise ProjectError(400, "模板选项无效。")
        else:
            fields[key] = content
    return _json(fields, 32000)


def _save_template(db, actor, body, identifier=None):
    row = _template(db, identifier) if identifier else None
    if row and (type(body.get("revision")) is not int or body["revision"] != row["revision"]):
        raise ProjectError(409, "模板已在其他页面更新，请刷新后继续。")
    if row and body.get("scope", row["scope"]) != row["scope"]:
        raise ProjectError(400, "模板类型创建后不可更改。")
    scope = row["scope"] if row else body.get("scope")
    if not isinstance(scope, str) or scope not in TEMPLATE_FIELDS:
        raise ProjectError(400, "请选择 AI 生图、图片编辑、海报、PPT 或 AI 对话模板。")
    name = _text(body.get("name", row["name"] if row else None), "模板名称", 80)
    description = _text(body.get("description", row["description"] if row else ""), "模板说明", 320, 0)
    settings = _template_settings(scope, body.get("settings", json.loads(row["settings"]) if row else {}))
    status = body.get("status", "draft")
    if status not in ("draft", "publish", "archive"):
        raise ProjectError(400, "模板状态无效。")
    updated = _now()
    version = row["revision"] + 1 if row else 1
    published = version if status == "publish" else row["published_revision"] if row else None
    archived = int(status == "archive" or (status == "draft" and row is not None and bool(row["archived"])))
    if row:
        db.execute("""UPDATE creative_templates SET revision=?,published_revision=?,archived=?,updated=?
            WHERE id=?""", (version, published, archived, updated, identifier))
    else:
        identifier = uuid.uuid4().hex
        db.execute("INSERT INTO creative_templates VALUES(?,?,?,?,?,?)", (identifier, scope, version, published, archived, updated))
    db.execute("""INSERT INTO creative_template_versions
        (template_id,revision,name,description,settings,actor,created) VALUES(?,?,?,?,?,?,?)""",
               (identifier, version, name, description, settings, actor, updated))
    return {"template": _template_view(_template(db, identifier), True)}


def route(db, method, path, owner, body=None):
    body = body if isinstance(body, dict) else {}
    if path == "/api/templates" and method == "GET":
        rows = db.execute(_template_query(True) + " WHERE t.archived=0 ORDER BY t.updated DESC,t.id").fetchall()
        return {"templates": [_template_view(row) for row in rows]}
    if not owner:
        raise ProjectError(401, "请先登录。")
    if path.startswith("/api/admin/"):
        actor = db.execute("SELECT role,active FROM users WHERE id=?", (owner,)).fetchone()
        if not actor or not actor["active"] or actor["role"] != "admin":
            raise ProjectError(403, "仅管理员可管理模板。")
        if path == "/api/admin/templates":
            if method == "GET":
                rows = db.execute(_template_query(False) + " ORDER BY t.updated DESC,t.id").fetchall()
                return {"templates": [_template_view(row, True) for row in rows]}
            if method == "POST":
                return _save_template(db, owner, body)
        match = re.fullmatch(r"/api/admin/templates/([a-f0-9]{32})", path)
        if match and method == "PUT":
            return _save_template(db, owner, body, match[1])
    elif path == "/api/projects":
        if method == "GET":
            rows = db.execute("""SELECT * FROM creative_projects WHERE owner=? AND scope!='poster'
                ORDER BY archived,updated DESC,id""", (owner,)).fetchall()
            return {"projects": [_project_view(row) for row in rows]}
        if method == "POST":
            return _create_project(db, owner, body)
    else:
        assets = re.fullmatch(r"/api/projects/([a-f0-9]{32})/assets", path)
        if assets and method == "GET":
            return project_assets(db, owner, assets[1])
        if assets and method in ("POST", "DELETE"):
            return update_project_assets(db, owner, assets[1], body, method)
        match = re.fullmatch(r"/api/projects/([a-f0-9]{32})", path)
        if match and method == "GET":
            return {"project": _project_view(_project(db, owner, match[1]), True)}
        if match and method == "PUT":
            return _update_project(db, owner, match[1], body)
        if match and method == "DELETE":
            return _update_project(db, owner, match[1], {**body, "deleted": True})
    raise ProjectError(404, "项目或模板接口不存在。")
