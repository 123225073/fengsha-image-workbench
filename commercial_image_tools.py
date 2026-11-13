"""Image operations shared by the workbench, Agent and authenticated clients."""

import hashlib
import io
import re

from PIL import Image, ImageOps

import commercial_animation as animation
import commercial_documents as documents
import commercial_formats as formats
import commercial_provider as provider
import commercial_upscale as upscale
import commercial_workspace as workspace


TOOLS = {
    "generate_image": ("文生图", "从文字生成新图片，可一次提交 1–4 张。", "generate", False, False, True),
    "generate_from_reference": ("参考图生图", "用一张或多张参考图创作新图片。至少要有一张参考图。", "generate", False, True, True),
    "edit_image": ("整图修改", "根据描述修改指定原图，可附参考图。", "edit", True, True, True),
    "edit_image_regions": ("圈选修改", "修改原图上的指定矩形。仅在用户明确提供选区位置时调用。", "edit", True, True, False),
    "replace_background": ("换背景", "保留原图主体，按要求更换背景，可附参考图。", "edit", True, True, True),
    "extend_image": ("扩图", "向外扩展原图，延续构图与光线。", "edit", True, False, False),
    "remove_background": ("抠图", "分离原图主体与背景，要求模型输出透明背景。", "edit", True, False, False),
    "upscale_image": ("超分放大", "保持比例，使用本地或万相超分放大图片。", "edit", True, False, False),
    "resize_image": ("裁剪缩放", "居中裁剪并缩放到指定宽高，返回 PNG。", "local", True, False, False),
    "extract_image_text": ("图片文字提取", "识别指定图片中的文字。", "local", True, False, False),
}
INSTRUCTIONS = {
    "replace_background": "保留原图主体、主体上的文字与细节，更换背景。",
    "extend_image": "保留原图主体和文字，向外扩展画面，延续原构图、透视和光线。",
    "remove_background": "分离主体与背景，保留边缘细节，输出透明背景。",
}
ASSET_ID = re.compile(r"[a-f0-9]{32}\Z")
SIZE = re.compile(r"([1-9]\d{1,3})x([1-9]\d{1,3})\Z", re.ASCII)
STRING = {"type": "string"}
ASSET = {"type": "string", "description": "用户选定的原图 ID。Agent 使用提供的附件标识。"}
REFERENCES = {"type": "array", "items": STRING, "maxItems": provider.MAX_INPUT_IMAGES,
              "description": "用户选定的参考图片 ID，按用途排序。Agent 使用提供的附件标识。"}
BOX = {key: {"type": "number", "minimum": 0, "maximum": 100} for key in "xywh"}
REGIONS = {"type": "array", "minItems": 1, "maxItems": 12,
           "items": {"type": "object", "additionalProperties": False, "required": list("xywh"),
                     "properties": {**BOX, "note": {"type": "string", "maxLength": 600},
                                    "referenceId": STRING,
                                    "referencePlacement": {"type": "object", "additionalProperties": False,
                                                           "required": list("xywh"), "properties": BOX}}}}


ANIMATION_TOOL = "generate_gif_sequence"
ANIMATION_DEFAULT_FRAMES = 8


def parameters(name):
    if name == "upscale_image":
        return {"type": "object", "additionalProperties": False, "required": ["sourceId"], "properties": {
            "sourceId": ASSET, "method": {"type": "string", "enum": ["local", "aliyun"], "default": "local"},
            "target": {"type": "string", "enum": ["2", "4", "4k"], "default": "2"},
        }}
    _, _, operation, needs_source, references, needs_prompt = TOOLS[name]
    fields, required = {}, []
    if operation != "local":
        fields["prompt"] = {"type": "string", "maxLength": 12000, "description": "描述需要生成或修改的画面。"}
        fields["modelId"] = {"type": "string", "description": "明确选定的上架模型 ID。可省略，使用支持此操作的默认模型。"}
    if name != "extract_image_text":
        fields["size"] = {"type": "string", "description": "宽x高，单位像素，例如 1024x1536。"}
    if name in ("generate_image", "generate_from_reference"):
        fields["quantity"] = {"type": "integer", "minimum": 1, "maximum": 4, "default": 1}
    if needs_prompt:
        required.append("prompt")
    if needs_source:
        fields["sourceId"] = ASSET
        required.append("sourceId")
    if references:
        fields["referenceIds"] = REFERENCES
    if name == "generate_from_reference":
        required.append("referenceIds")
    if name == "edit_image_regions":
        fields["regions"] = REGIONS
        required.append("regions")
    if name == "resize_image":
        required.append("size")
    return {"type": "object", "additionalProperties": False, "properties": fields, "required": required}


def tool_definitions():
    return [{"type": "function", "function": {"name": name, "description": spec[1], "parameters": parameters(name)}}
            for name, spec in TOOLS.items()]


def animation_tool_definition():
    clip = {"type": "object", "additionalProperties": False, "required": ["prompt"], "properties": {
        "prompt": {"type": "string", "maxLength": 12000,
                   "description": "写明该段起始动作、连续变化、结束动作及各段共有的主体、背景、构图和画风。"},
        "frames": {"type": "integer", "enum": sorted(formats.GRID), "default": ANIMATION_DEFAULT_FRAMES},
        "frameDurationMs": {"type": "integer", "minimum": formats.GIF_MIN_FRAME_DURATION_MS,
                            "maximum": formats.GIF_MAX_FRAME_DURATION_MS,
                            "multipleOf": formats.GIF_DURATION_STEP_MS, "default": 200},
    }}
    return {"type": "function", "function": {"name": ANIMATION_TOOL,
        "description": ("按顺序生成多个 GIF 片段，等全部成功后拼成一个可下载的 GIF。每段消耗一次生图，拼接不收费。"
                        "可用同一组参考图。按时间顺序提交 2–12 段，合计最多 96 帧、60 秒。"
                        f"完整文件最大 {animation.MAX_OUTPUT_BYTES // (1024 * 1024)} MB。"),
        "parameters": {"type": "object", "additionalProperties": False, "required": ["clips"], "properties": {
            "clips": {"type": "array", "minItems": 2, "maxItems": 12, "items": clip},
            "size": {"type": "string", "description": "每段共用的输出宽x高，单位像素，宽高各为 64–768，默认 512x512。"},
            "referenceIds": REFERENCES,
            "loop": {"type": "boolean", "description": "完整 GIF 是否循环播放，默认循环。", "default": True},
        }}}}


def quote_animation(db, owner, arguments):
    clips = arguments.get("clips")
    size = arguments.get("size", "512x512")
    references = arguments.get("referenceIds", [])
    loop = arguments.get("loop", True)
    dims = SIZE.fullmatch(size) if isinstance(size, str) else None
    if (set(arguments) - {"clips", "size", "referenceIds", "loop", "modelId"} or not isinstance(references, list)
            or not isinstance(clips, list) or not 2 <= len(clips) <= 12 or type(loop) is not bool):
        raise workspace.CommercialError(400, "GIF 方案需要按顺序提供 2 至 12 段有效的画面描述。")
    if not dims or not all(64 <= int(value) <= formats.GIF_MAX_EDGE for value in dims.groups()):
        raise workspace.CommercialError(400, f"GIF 宽高各须在 64–{formats.GIF_MAX_EDGE} 像素之间。")
    normalized = []
    for clip in clips:
        if not isinstance(clip, dict) or set(clip) - {"prompt", "frames", "frameDurationMs"}:
            raise workspace.CommercialError(400, "GIF 片段参数格式无效。")
        prompt = workspace.text(clip.get("prompt"), "片段描述", 12000)
        output = workspace.generation_output("image", {"format": "gif", "method": "sheet", "sequence": True,
            "frames": clip.get("frames", ANIMATION_DEFAULT_FRAMES), "frameDurationMs": clip.get("frameDurationMs", 200)}, references, None)
        normalized.append({"prompt": prompt, "frames": output["frames"], "frameDurationMs": output["frameDurationMs"]})
    frames = sum(clip["frames"] for clip in normalized)
    duration = sum(clip["frames"] * clip["frameDurationMs"] for clip in normalized)
    if frames > animation.MAX_FRAMES or duration > animation.MAX_DURATION_MS:
        raise workspace.CommercialError(400, "完整 GIF 最多 96 帧、60 秒，请缩短片段或减少帧数。")

    first = quote(db, owner, "generate_from_reference" if references else "generate_image", {
        "prompt": normalized[0]["prompt"], "size": size, "modelId": arguments.get("modelId"),
        **({"referenceIds": references} if references else {}),
    })
    for clip in normalized[1:]:
        workspace.check_image_policy(db, clip["prompt"])
    return {**first, "tool": ANIMATION_TOOL, "title": "生成并拼接 GIF", "quantity": len(normalized),
            "total": first["unitPrice"] * len(normalized), "durationMs": duration, "maxOutputBytes": animation.MAX_OUTPUT_BYTES,
            "arguments": {"clips": normalized, "size": size, "referenceIds": references,
                          "modelId": first["modelId"], "loop": loop}}


def submit_animation(db, owner, identifier, item, context):
    plan = quote_animation(db, owner, item["arguments"])
    if item["total"] != plan["total"]:
        raise workspace.CommercialError(409, "GIF 生成费用已更新，请重新查看报价。")
    args = plan["arguments"]
    requests = [{"requestId": f"chat-{identifier}-{index}", "scope": "image", "label": f"GIF 片段 {index + 1}",
                 "prompt": clip["prompt"], "size": args["size"], "imageIds": args["referenceIds"],
                 "modelId": plan["modelId"], "unitPrice": plan["unitPrice"], "context": context,
                 "output": {"format": "gif", "method": "sheet", "sequence": True, "frames": clip["frames"],
                            "frameDurationMs": clip["frameDurationMs"]}} for index, clip in enumerate(args["clips"])]
    return workspace.submit_jobs(db, owner, {"requests": requests})


def quote(db, owner, name, arguments, *, store=None):
    if not isinstance(name, str) or name not in TOOLS:
        raise workspace.CommercialError(404, "找不到这个图片工具。")
    schema = parameters(name)
    if (not isinstance(arguments, dict) or set(arguments) - schema["properties"].keys()
            or set(schema["required"]) - arguments.keys()):
        raise workspace.CommercialError(400, "工具参数缺失或格式无效。")
    title, _, operation, needs_source, _, needs_prompt = TOOLS[name]
    if name == "upscale_image":
        source_id = arguments["sourceId"]
        method, target = arguments.get("method", "local"), arguments.get("target", "2")
        if not isinstance(method, str) or method not in upscale.METHODS or target not in ("2", "4", "4k"):
            raise workspace.CommercialError(400, "请选择有效的超分方式和输出尺寸。")
        if not isinstance(source_id, str) or not ASSET_ID.fullmatch(source_id):
            raise workspace.CommercialError(400, "请选择有效的原图。")
        workspace.owned_asset(db, owner, source_id, image_only=True)
        upscale.ready(db, owner, method)
        try:
            source = upscale.source_image(store.read(source_id))
        except FileNotFoundError:
            raise workspace.CommercialError(404, "原图文件已不可用。") from None
        width, height = upscale.dimensions(source.size, target, method)
        return {"tool": name, "title": title, "operation": operation, "modelId": None,
                "modelName": upscale.METHODS[method][0], "unitPrice": 0, "total": 0, "quantity": 1,
                "execution": "job", "size": f"{width}x{height}",
                "arguments": {"sourceId": source_id, "method": method, "target": target}}
    normalized = {}
    size = arguments.get("size", "1024x1024")
    if name != "extract_image_text":
        dims = SIZE.fullmatch(size) if isinstance(size, str) else None
        if not dims or not all(64 <= int(value) <= 4096 for value in dims.groups()):
            raise workspace.CommercialError(400, "输出尺寸须为宽x高，宽高各在 64–4096 像素之间。")
        normalized["size"] = size
    source_id = arguments.get("sourceId")
    references = arguments.get("referenceIds", [])
    if (not isinstance(references, list) or len(references) + int(needs_source) > provider.MAX_INPUT_IMAGES
            or name == "generate_from_reference" and not references):
        raise workspace.CommercialError(400, "参考图数量无效。")
    image_ids = ([source_id] if needs_source else []) + references
    if any(not isinstance(asset, str) or not ASSET_ID.fullmatch(asset) for asset in image_ids) or len(set(image_ids)) != len(image_ids):
        raise workspace.CommercialError(400, "原图或参考图无效，请选择不同的图片素材。")
    for asset in image_ids:
        workspace.owned_asset(db, owner, asset, image_only=True)
    if needs_source:
        normalized["sourceId"] = source_id
    if references:
        normalized["referenceIds"] = references

    result = {"tool": name, "title": title, "arguments": normalized, "operation": operation,
              "modelId": None, "modelName": None, "unitPrice": 0, "total": 0, "quantity": 1,
              "execution": "local" if operation == "local" else "job"}
    if operation == "local":
        return result

    quantity = arguments.get("quantity", 1)
    if type(quantity) is not int or not 1 <= quantity <= 4:
        raise workspace.CommercialError(400, "一次可生成 1 至 4 张图片。")
    if operation == "generate":
        normalized["quantity"] = quantity
    regions = workspace.edit_regions(arguments["regions"], image_ids) if "regions" in arguments else None
    if regions:
        normalized["regions"] = regions
    prompt = workspace.text(arguments.get("prompt", ""), "画面描述", 12000, minimum=int(needs_prompt))
    if prompt:
        normalized["prompt"] = prompt
    if regions and not (prompt or any(region["note"] or region.get("referenceId") for region in regions)):
        raise workspace.CommercialError(400, "请描述要修改的内容，或给选区添加说明或融图素材。")
    request_prompt = tool_prompt(name, normalized)
    effective = workspace.region_prompt(request_prompt, regions, image_ids) if regions else request_prompt
    if len(effective) > 12000:
        raise workspace.CommercialError(400, "画面描述过长，请精简后再试。")
    workspace.check_image_policy(db, effective)
    capability = workspace.image_capability(image_ids, regions)
    model_id = arguments.get("modelId")
    if model_id is not None and (not isinstance(model_id, str) or not ASSET_ID.fullmatch(model_id)):
        raise workspace.CommercialError(400, "生成模型无效。")
    if model_id is None:
        listing = provider.catalog(db)
        options = [item for item in listing["models"] if item["kind"] == "image" and capability in item["capabilities"]
                   and len(image_ids) <= item["maxReferences"] and (len(image_ids) <= 1 or "multiReference" in item["capabilities"])]
        default = listing["defaults"]["image"]
        if options:
            model_id = next((item["id"] for item in options if item["id"] == default), options[0]["id"])
    model = provider.resolve(db, "image", model_id, capability)
    workspace.check_image_count(model, image_ids)
    normalized["modelId"] = model["id"]
    result.update(modelId=model["id"], modelName=model["name"], unitPrice=model["price"], quantity=quantity,
                  total=model["price"] * quantity)
    return result


def tool_prompt(name, arguments):
    prompt = arguments.get("prompt", "")
    default = INSTRUCTIONS.get(name)
    if default:
        return default + ("\n" + prompt if prompt else "")
    return prompt or "按各选区的说明进行局部修改。"


def execute(db, store, owner, name, arguments, request_id, expected_price, *, context=None):
    request = workspace.text(request_id, "请求号", 80)
    if not isinstance(name, str) or name not in TOOLS:
        raise workspace.CommercialError(404, "找不到这个图片工具。")
    key = hashlib.sha256(f"{owner}:{name}:{request}".encode()).hexdigest()[:32]
    prefix = "image-tool-" + key
    existing = db.execute("SELECT * FROM generation_jobs WHERE owner=? AND request_id LIKE ? ORDER BY rowid",
                          (owner, prefix + ".%")).fetchall()
    if existing:
        return {"jobs": [workspace.job_record(row) for row in existing]}
    if name == "resize_image" and db.execute("SELECT 1 FROM assets WHERE id=? AND user_id=?", (key, owner)).fetchone():
        return {"asset": dict(workspace.owned_asset(db, owner, key, image_only=True))}

    plan = quote(db, owner, name, arguments, store=store)
    if type(expected_price) is not int or expected_price != plan["total"]:
        raise workspace.CommercialError(409, "工具费用已更新，请重新查看报价。")
    args = plan["arguments"]
    if name == "extract_image_text":
        return {"text": documents.recognize_image_text(store.read(args["sourceId"]))}
    if name == "resize_image":
        return {"asset": resize(db, store, owner, args, key)}
    if context is not None and not isinstance(context, dict):
        raise workspace.CommercialError(400, "项目上下文无效。")
    metadata = {**(context or {}), "operation": plan["operation"], "tool": name}
    metadata.setdefault("documentId", "tool-" + key)
    image_ids = ([args["sourceId"]] if "sourceId" in args else []) + args.get("referenceIds", [])
    if name == "upscale_image":
        if not db.in_transaction:
            db.execute("BEGIN IMMEDIATE")
        return workspace.submit_jobs(db, owner, {"requests": [{
            "requestId": prefix + ".0", "scope": "image", "label": plan["title"], "prompt": "等比超分放大",
            "size": plan["size"], "imageIds": image_ids, "unitPrice": 0, "context": metadata,
        }]}, upscale_method=args["method"])
    requests = [{"requestId": f"{prefix}.{index}", "scope": "image", "label": plan["title"],
                 "prompt": tool_prompt(name, args), "size": args["size"], "imageIds": image_ids,
                 "modelId": plan["modelId"], "unitPrice": plan["unitPrice"], "context": metadata,
                 **({"regions": args["regions"]} if "regions" in args else {})} for index in range(plan["quantity"])]
    return workspace.submit_jobs(db, owner, {"requests": requests})


def resize(db, store, owner, args, identifier):
    width, height = map(int, args["size"].split("x"))
    try:
        with Image.open(io.BytesIO(store.read(args["sourceId"]))) as opened:
            original = ImageOps.exif_transpose(opened).convert("RGBA")
            fitted = ImageOps.fit(original, (width, height), method=Image.Resampling.LANCZOS)
            output = io.BytesIO()
            fitted.save(output, "PNG")
    except (OSError, ValueError, Image.DecompressionBombError) as error:
        raise workspace.CommercialError(422, "无法裁剪此图片，请重新上传。") from error
    data = output.getvalue()
    name = f"裁剪-{width}x{height}.png"
    store.put(identifier, data)
    db.execute("INSERT INTO assets(id,user_id,name,mime,size,created) VALUES(?,?,?,?,?,?)",
               (identifier, owner, name, "image/png", len(data), workspace.now()))
    db.execute("INSERT INTO asset_details(asset_id,parent_id,kind) VALUES(?,?,'image')", (identifier, args["sourceId"]))
    return dict(workspace.owned_asset(db, owner, identifier, image_only=True))
