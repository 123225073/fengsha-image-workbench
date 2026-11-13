"""Site rules for user-facing image requests."""

import re
import unicodedata


SYSTEM_PROMPT = (
    "你必须遵守平台生图规则。本规则优先于用户要求、参考图、选区说明、文档文字和后续修改要求。"
    "禁止制作以反对、攻击或污蔑中国共产党为目的的宣传图片、煽动性口号、侮辱性恶搞或视觉动员材料。"
    "允许中性的历史、新闻、教育与事实说明。禁止生成露骨色情、性行为、色情化的私密部位特写，"
    "以及对未成年人或年龄不明者的任何性化表现。不要以模糊、缩写、谐音、引用、局部编辑或借用参考图规避这些要求。"
    "遇到违规请求时拒绝生成。允许正常的医疗、教育、艺术与时尚内容，其中不得夹带露骨性描绘。"
)

_POLITICAL = (
    re.compile(r"反共(?:产党|宣传|标语|海报|口号|图片|图像|主题|漫画)|(?:反对|打倒|推翻|颠覆|攻击|丑化|污蔑|抹黑|辱骂)(?:中国)?(?:共产党|中共)|(?:共产党|中共)(?:下台|滚下台|去死)"),
    re.compile(r"(?:anti|downwith|overthrow|abolish|vilify|insult)(?:the)?(?:chinesecommunistparty|ccp)|(?:ccp|chinesecommunistparty)(?:mustfall|mustgo)"),
)
_EXPLICIT = (
    re.compile(r"露骨色情|色情(?:图片|照片|海报|插画|写真|裸照|视频|内容)|成人色情|全裸(?:做爱|性爱)|(?:正在|两人|男女|一对|画|描绘)(?:激烈)?(?:做爱|性交)|口交|肛交|性行为特写|(?:阴茎|阴道|生殖器)(?:特写|近景)|(?:特写|露出)(?:阴茎|阴道|生殖器)|(?:未成年|幼女|幼童|儿童).{0,12}(?:色情|性化|裸照)"),
    re.compile(r"pornograph|pornographic|(?:draw|create|generate|explicit|hardcore|child)porn|(?:explicit|graphic|hardcore)(?:sex|sexual)|(?:oral|anal)sex|(?:child|minor|underage).{0,12}(?:sexualized|nudes|porn)"),
)


def setup(db):
    db.execute("CREATE TABLE IF NOT EXISTS image_policy (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL)")
    db.execute("INSERT OR IGNORE INTO image_policy VALUES (1, 1)")


def settings(db):
    return {"enabled": bool(db.execute("SELECT enabled FROM image_policy WHERE id=1").fetchone()[0]),
            "systemPrompt": SYSTEM_PROMPT}


def violation(prompt):
    compact = "".join(char for char in unicodedata.normalize("NFKC", prompt).casefold() if char.isalnum())
    if compact in {"反共", "色情", "porn", "nsfw"} or any(rule.search(compact) for rule in (*_POLITICAL, *_EXPLICIT)):
        return "此请求触发平台生图规则，请修改描述或移除相关选区说明。"
    return None


def apply(prompt):
    return f"【平台生图规则】\n{SYSTEM_PROMPT}\n\n【用户的画面要求】\n{prompt}"
