#!/usr/bin/env python3
"""h3q - H3/画布视频制作工具（知识按需提取 + 队列静态校验）。

用法:
  python h3q.py list                         列出知识模块和小节（含 Seedance 2.5 模块）
  python h3q.py get <模块> [小节关键词]       取一个模块或其中一节
  python h3q.py find <关键词或标签> [...]      跨模块搜规则（标签: 打斗 法术 对白 口型 湿态 服装 道具 手 场景 光 群戏 续接 锚点 编号 表演 声音 运行 seedance）
  python h3q.py skeleton <T2VA|I2VA|FL2VA|L2VA|Ref2VA|对白|运镜>   官方格式骨架
  python h3q.py template <ref|chain|first>   队列单镜模板
  python h3q.py check <queue.json>           队列静态校验（ERROR 必改 / WARN 需确认 / HINT 建议）
                                             队列旁必须有 <队列名>_对照表.md（get 导演 逐镜对照表）；查旧队列加 --skip-table
                                             用了本集设定（episode + {{本集.…}}）的队列先展开再查
  python h3q.py expand <queue.json> [-o 输出.json]   把本集设定展开成旧格式队列（逐字展开，去掉 episode）
"""
import sys, os, json, re, glob, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "h3q_data.json")
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

TAGS = {
    "打斗": ["打斗", "打戏", "发力", "命中", "攻防", "交手", "剑", "掌"],
    "法术": ["法术", "法光", "特效", "阵法", "剑气", "发光", "glow", "bloom"],
    "对白": ["对白", "台词", "dialogue", "speaker", "说话"],
    "口型": ["口型", "嘴", "lips", "闭嘴", "画外", "offscreen", "独白"],
    "湿态": ["湿", "干湿", "soaked", "wet"],
    "服装": ["服装", "换衣", "outfit", "西装"],
    "道具": ["道具", "数量", "尺寸", "长杆", "手机", "exactly"],
    "手": ["手", "粘连", "握"],
    "场景": ["场景", "母版", "布景", "背景", "电线", "建筑"],
    "光": ["光", "light", "色温", "灯"],
    "群戏": ["多人", "群", "背景角色", "双人", "stays in frame"],
    "续接": ["尾帧", "接帧", "firstFrameFrom", "续段", "首帧", "衔接"],
    "编号": ["Picture", "Subject", "编号"],
    "表演": ["表演", "表情", "冻人", "微", "冷笑"],
    "声音": ["声音", "soundscape", "配乐", "soundMode", "music"],
    "运行": ["收件箱", "_control", "心跳", "stale", "STOP", "validate"],
    "seedance": ["Seedance", "@Image", "@Video", "即梦", "Stage"],
    "锚点": ["锚点", "timeAnchors", "AddGuide", "多关键帧"],
}


def load():
    with open(DATA, encoding="utf-8") as f:
        return json.load(f)


def out(s):
    print(s.rstrip())


def cmd_list(d, a):
    for name, m in d["modules"].items():
        out("%s ｜ %s" % (name, m["title"]))
        out("    小节: " + " / ".join(s["h"] for s in m["sections"]))
    out("\n其他: skeleton %s | template ref/chain/first | vocab %s" % (
        "/".join(d["skeleton"].keys()), "/".join("%s(%d)" % (k, len(v)) for k, v in d["vocab"].items())))


def find_module(d, key):
    if key in d["modules"]:
        return key
    kl = key.lower()
    for k, m in d["modules"].items():
        if kl in k.lower() or kl in m["title"].lower():
            return k
    return None


def cmd_get(d, a):
    if not a:
        return cmd_list(d, a)
    k = find_module(d, a[0])
    if not k:
        out("没有模块: %s（运行 list 查看）" % a[0]); return 1
    m = d["modules"][k]
    secs = m["sections"]
    if len(a) > 1:
        q = a[1]
        secs = [s for s in secs if q in s["h"]] or [s for s in secs if q in s["t"]]
        if not secs:
            out("模块 %s 里没有含“%s”的小节；可选: %s" % (k, q, " / ".join(s["h"] for s in m["sections"]))); return 1
    else:
        out("# %s ｜ %s" % (k, m["title"]))
    for s in secs:
        out("## %s/%s\n%s\n" % (k, s["h"], s["t"]))


def cmd_find(d, a):
    if not a:
        out("用法: find <关键词或标签>"); return 1
    keys = []
    for x in a:
        keys += TAGS.get(x, [x])
    hits = 0
    for k, m in d["modules"].items():
        for s in m["sections"]:
            for line in s["t"].split("\n"):
                if line.strip() and any(q.lower() in line.lower() for q in keys):
                    out("[%s/%s] %s" % (k, s["h"], line.strip()))
                    hits += 1
    if not hits:
        out("没找到。可用标签: " + " ".join(TAGS))


def cmd_skeleton(d, a):
    sk = d["skeleton"]
    if not a or a[0] not in sk:
        out("可选: " + " ".join(sk)); return 1
    out(sk[a[0]])


def cmd_template(d, a):
    t = d["templates"]
    if not a or a[0] not in t:
        out("可选: ref（全能参考+对白） chain（接尾帧） first（定稿首帧）"); return 1
    out(json.dumps(t[a[0]], ensure_ascii=False, indent=2))


def take_n(a, default):
    n = default
    if "-n" in a:
        i = a.index("-n")
        try:
            n = int(a[i + 1])
        except Exception:
            pass
        a = a[:i] + a[i + 2:]
    return a, n


def cmd_vocab(d, a):
    a, n = take_n(a, 15)
    v = d["vocab"]
    alias = {"运镜": "camera", "光": "light", "构图": "compose", "镜头": "lens", "剪辑": "edit", "特效": "fx",
             "胶片": "film", "叙事": "story", "打斗": "fight", "微表情": "face", "表情": "face"}
    if not a:
        out("类: " + " ".join("%s(%d)" % (k, len(x)) for k, x in v.items()) + "；中文别名: " + " ".join(alias)); return 1
    cat = alias.get(a[0], a[0])
    if cat not in v:
        out("没有这个类: " + a[0]); return 1
    rows = v[cat]
    if len(a) > 1:
        qs = a[1:]
        rows = [r for r in rows if all(q.lower() in (r[0] + r[1]).lower() for q in qs)]
    if cat == "fight":
        out("提醒: 打斗库多为游戏CG写法。只取招式与身体动作，改写成 发力线+接触+代价+物理反馈，法光≤0.5s薄闪，不写持续发光/定格/慢动作。")
    for r in rows[:n]:
        out("- %s%s" % (r[0], ("：" + r[1][:120]) if r[1] else ""))
    out("（共 %d 条匹配，显示 %d 条；-n 调整）" % (len(rows), min(n, len(rows))))


# ---------------- 队列校验 ----------------
ENUM = {
    "aspect": {"16:9", "9:16", "1:1", "4:3", "3:4"},
    "soundMode": {"av", "ambient", "silent"},
    "generationMode": {"auto", "first-last", "extend"},
    "workflow": {"ultimate", "fast"},
    "resolution": {"480p", "720p"},
}
KNOWN = {"title", "prompt", "roleIds", "sceneAssetIds", "seconds", "aspect", "soundMode", "generationMode", "workflow",
         "megapixels", "resolution", "seed", "dialogue", "autoVoiceDisabled", "voiceRoleId", "offscreenRoleIds",
         "firstFrameAssetId", "lastFrameAssetId", "firstFrameFrom", "lastFrameFrom", "sourceVideoAssetId", "sourceShot",
         "shotId", "noBackgroundMusic", "timeAnchors", "voiceRoleIds"}
PLACEHOLDER = re.compile(r"REPLACE|TODO|占位|<[^>]+>|\bxxx\b", re.I)
HOLD = re.compile(r"hold (this|the) (composition|frame|pose)|end(s)? held|settles? and holds?|freeze[s]? (on|in)|freeze[- ]frame|定格|完全静止|静止不动|保持不动|画面停住|停住不动|收束定格", re.I)
META = re.compile(r"dialogue (line|track)|line \d+ of the dialogue|台词\s*\d|第\s*\d+\s*句台词|only the lines in", re.I)
FRAME_AS_PIC = re.compile(r"<Picture\s*(\d+)>\s*(is|=|:)?\s*(the\s+)?(inherited|opening|first|last|final|ending)\s*(last\s+)?frame", re.I)
GLOW = re.compile(r"(faint|soft|gentle|subtle)?\s*(glow|glowing|bloom|neon|pulsing)", re.I)
NOGLOW = re.compile(r"no[^.]{0,20}(glow|bloom|neon|pulsing)", re.I)
# v2026-11-18 去噪：只在「法术/能量类发光」或 neon/pulsing、且同一句没写熄灭/时长时提示；普通灯光的 warm glow 不报
GLOW_MAGIC = re.compile(r"magic|spell|aura|energy|qi\b|rune|talisman|sword|blade|weapon|staff|seal|orb|法|剑|刀|灵力|符|印", re.I)
GLOW_FADE = re.compile(r"fades?|dies (away|down)|for (a|one) (moment|second|beat)|briefly|brief|flash|\d(\.\d)?\s*s(ec|econds?)?\b|熄|一闪", re.I)
def glow_hits(t):
    n = 0
    for sent in re.split(r"(?<=[.。!?！？])\s*", t):
        if not GLOW.search(sent) or NOGLOW.search(sent):
            continue
        if re.search(r"neon|pulsing", sent, re.I) or GLOW_MAGIC.search(sent):
            if not GLOW_FADE.search(sent):
                n += 1
    return n
NOBG = re.compile(r"no (music and no )?other background sound", re.I)


class Rep:
    def __init__(self):
        self.items = []

    def add(self, lvl, where, msg):
        self.items.append((lvl, where, msg))


ID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


def is_id(x):
    """画布角色库 / 素材库的 ID 都是 UUID 形状（8-4-4-4-12 位十六进制）。"""
    return isinstance(x, str) and bool(ID_RE.match(x))


def id_checks(rep, W, s):
    """ID 字段只能填 ID（正本 字段）。2026-11-11（实测）：roleIds 里填了一句服装描述，画布排不出参考图，h3q 原来 0 错。"""
    items = []
    for k in ("roleIds", "sceneAssetIds", "offscreenRoleIds"):
        arr = s.get(k)
        if isinstance(arr, list):
            items += [("%s 第 %d 项" % (k, n + 1), x) for n, x in enumerate(arr)]
    for k in ("firstFrameAssetId", "lastFrameAssetId", "sourceVideoAssetId", "voiceRoleId"):
        if s.get(k) not in (None, ""):
            items.append((k, s.get(k)))
    for n, an in enumerate(s.get("timeAnchors") or []):
        if isinstance(an, dict) and "assetId" in an:
            items.append(("timeAnchors 第 %d 项 assetId" % (n + 1), an.get("assetId")))
    for n, d in enumerate(s.get("dialogue") or []):
        if isinstance(d, dict):
            if "roleId" in d:
                items.append(("dialogue 第 %d 句 roleId" % (n + 1), d.get("roleId")))
            v = d.get("voice")
            if isinstance(v, str) and v.startswith("audio:"):
                items.append(("dialogue 第 %d 句 voice" % (n + 1), v[6:]))
    for where, x in items:
        if is_id(x):
            continue
        txt = str(x) if not isinstance(x, str) else x
        rep.add("ERROR", W, "[ID] %s 不是 ID：「%s%s」。应填角色库 / 素材库里的 ID（8-4-4-4-12 位，如 c68aa343-fccb-4877-a776-2fc30bef7df0）；描述写在正文里；没有这个角色就先在画布角色库里建" % (where, txt[:20], "…" if len(txt) > 20 else ""))


def is_num(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def check_mp(rep, where, obj):
    if "megapixels" in obj:
        mp = obj["megapixels"]
        if not is_num(mp) or not (0.30 <= mp <= 1.00):
            rep.add("ERROR", where, "megapixels 必须是 0.30～1.00 的数字，现在是 %r" % (mp,))
    if "resolution" in obj and obj["resolution"] not in ENUM["resolution"]:
        rep.add("ERROR", where, "resolution 只能 480p/720p")
    if "seed" in obj:
        s = obj["seed"]
        if not (s == "random" or (isinstance(s, int) and not isinstance(s, bool) and 0 <= s <= 9007199254740991)):
            rep.add("ERROR", where, "seed 只能是非负整数或 \"random\"")
    for k in ("workflow", "generationMode"):
        if k in obj and obj[k] not in ENUM[k]:
            rep.add("ERROR", where, "%s 非法: %r（合法 %s）" % (k, obj[k], "/".join(sorted(ENUM[k]))))


TABLE_FIELDS = ["剧本", "机位", "开始", "时间段", "结束", "拍不出或矛盾", "取过的规则"]
SEG = re.compile(r"\d{2}:\d{2}\s*-\s*\d{2}:\d{2}")


def strip_punct(t):
    return re.sub(r"[^一-鿿A-Za-z0-9]", "", t or "")


def check_table(rep, path, shots, skip):
    """逐镜对照表（2026-11-08）：队列旁必须有 <队列名>_对照表.md，每镜一节。"""
    lvl = "WARN" if skip else "ERROR"
    tp = os.path.splitext(path)[0] + "_对照表.md"
    tip = "（写法：python h3q.py get 导演 逐镜对照表）"
    if not os.path.exists(tp):
        rep.add(lvl, "对照表", "队列旁没有 %s。先逐镜写对照表（剧本原文、唯一机位、时间段、拍不出或矛盾、取过的规则），提示词只照表写%s" % (os.path.basename(tp), tip))
        return
    with open(tp, encoding="utf-8-sig") as f:
        txt = f.read()
    secs = {}
    cur = None
    for line in txt.splitlines():
        m = re.match(r"^##\s+(.+?)\s*$", line)
        if m:
            cur = m.group(1); secs[cur] = []; continue
        if cur is not None:
            secs[cur].append(line)
    for i, s in enumerate(shots):
        t = s.get("title") if isinstance(s, dict) else None
        W = "对照表 镜%d" % (i + 1)
        if not t:
            continue
        if t not in secs:
            rep.add(lvl, W, "没有「## %s」这一节（标题要和队列 title 完全一样）%s" % (t, tip)); continue
        body = "\n".join(secs[t])
        fields = {}
        for k in TABLE_FIELDS:
            m = re.search(r"^\s*%s\s*[:：](.*?)(?=^\s*(?:%s)\s*[:：]|\Z)" % (k, "|".join(TABLE_FIELDS)), body, re.M | re.S)
            fields[k] = m.group(1).strip() if m else None
        miss = [k for k, v in fields.items() if not v]
        if miss:
            rep.add(lvl, W, "缺或空着：%s%s" % ("、".join(miss), tip))
        rules = fields.get("取过的规则") or ""
        if rules and "get 提示词" not in rules:
            rep.add(lvl, W, "取过的规则里没有 get 提示词 范本；写之前必须先取")
        dl = s.get("dialogue") or []
        if dl and rules and "口型" not in rules:
            rep.add("WARN", W, "本镜有台词，但没取过口型规则（find 口型）")
        script = strip_punct(fields.get("剧本") or "")
        if script:
            for li, x in enumerate(dl):
                tx = strip_punct(x.get("text") if isinstance(x, dict) else "")
                if tx and tx not in script:
                    rep.add("WARN", W, "台词%d 在对照表的剧本原文里找不到，台词和剧本对不上" % (li + 1))
        n_tab = len(SEG.findall(fields.get("时间段") or ""))
        n_pr = len(SEG.findall(s.get("prompt") or ""))
        if n_tab and n_pr and n_tab != n_pr:
            rep.add("WARN", W, "对照表 %d 个时间段，prompt 里 %d 个；提示词要和对照表一一对应" % (n_tab, n_pr))
        for seg in re.findall(r"\d{2}:\d{2}\s*-\s*\d{2}:\d{2}[^\n]*", fields.get("时间段") or ""):
            if re.search(r"不动|保持|静止|站着|坐着|无动作|没动作|还在|还看着|视线停|停在|一直看", seg) and not re.search(r"补|翻|放|拿|看向|转|走|抬|低|伸|推|拉|递|起身|坐下|开口|说|绷|抽|飞|掉|落|冲|流|涌|晃|摇|甩|扑|跑|追|喊|笑|哭|眨|吹|飘|滴|漂|裂|碎|倒|升|降|亮|暗|变|开|关|跳|滚|爬|撞|砸|炸|退|散|卷|溅|喘|皱|咽|点头|摇头|握|松|捏|指|靠|蹲|站起|弯|扭|撑|踢|踩|挥|打|拍|摸|擦|拽|扯|拖|搬|抱|背|扛|塞|丢|扔|接|递", re.sub(r"说完|已说|话已|停了|嘴唇闭着|仍在手里", "", seg)):
                rep.add("WARN", W, "时间段「%s」没有看得见的动作，模型会自己编动作；缩短秒数或补一个小动作并注明" % seg.strip()[:40])
        cam = fields.get("机位") or ""
        if re.search(r"或者|或是|也可以|也可|两个机位|两种|/|门外.{0,20}窗|窗.{0,20}门外", cam):
            rep.add("WARN", W, "机位一栏像是写了不止一个机位：%s；一镜只留一个，另一个写进「拍不出或矛盾」" % cam[:50].replace("\n", " "))
        start = fields.get("开始") or ""
        if start and len(s.get("roleIds") or []) >= 1 and not re.search(r"画左|画右|画中|画面左|画面右|画面中|左侧|右侧|左边|右边|前景|背景|中景|frame.?left|frame.?right|screen.?left|screen.?right", start, re.I):
            rep.add("WARN", W, "「开始」没写人物在画面哪里（画左/画右/画中、前景/背景）；按镜头视角写站位，不要只写靠门一侧（get 导演 剧本分镜写法）")
        issue = fields.get("拍不出或矛盾") or ""
        # v2026-11-18 去噪：写了「无」，或写明用户已定 / 按用户要求处理的，算已决
        if issue and not re.match(r"^(无|没有|无。|none)", issue.strip(), re.I) and not re.search(r"按用户|用户(已)?(定|批准|同意|确认|要求)|已定|已解决|已批准", issue):
            rep.add("HINT", W, "对照表有未决的拍不出/矛盾项，确认用户已经批准处理方法：%s" % issue[:60].replace("\n", " "))


SHOTSIZE = re.compile(r"close.?up|medium|wide shot|full shot|long shot|two.?shot|over.the.shoulder|establishing|waist|chest.?up|head and shoulders|knees up|cowboy shot|full.?length|特写|近景|中景|全景|远景", re.I)
PLACE = re.compile(r"三分之一|黄金|画左|画右|画中|画面左|画面右|画面中|前景|背景|居中|third|golden|placed|frame.?left|frame.?right|screen.?left|screen.?right|left of (the )?frame|right of (the )?frame|cent(re|er) of (the )?frame|upper|foreground|background", re.I)
PERF = re.compile(r"下颌|下巴绷|眉|眨眼|呼吸|屏息|吞咽|喉结|手指(收紧|蜷|攥)|攥紧|握紧|肩膀|眼神|瞥|笑|皱眉|抿嘴|咬唇|重心|点头|嘴角|脸红|垂眼|jaw|brow|blink|breath|exhal|inhal|swallow|fingers? (tighten|curl|press|flex)|grip|shoulders?|eyes (narrow|widen|drop|flick)|glanc|smile|frown|purse|tighten|weight shift|shifts (his|her) weight|nods?|swallows|mouth corners?", re.I)


PERF_EN = re.compile(r"\b(?:squint\w*|grin(?:s|ned|ning)?|smil\w*|smirk\w*|frown\w*|brows?|lips?|purs\w*|bit(?:e|es|ing)|swallow\w*|sigh(?:s|ed|ing)?|exhal\w*|inhal\w*|breath\w*|blink\w*|glanc\w*|nod(?:s|ded|ding)?|tilt\w*|shrug\w*|shoulders?|jaws?|tighten\w*|clench\w*|flinch\w*|laugh\w*|chuckl\w*)", re.I)  # blush 不算：害羞不写脸红


def detail_body_checks(rep, W, body, need_perf=True, official=False):
    """细节清单第 4、5 条（表情/小反应、左右手）。旧格式和官方格式共用，body 是 detailed_description 之后的正文。
    第 4 条官方格式只提示（HINT）：词表再宽也有漏网的写法，官方格式的表演常写在整段动作里。"""
    if need_perf and not (PERF.search(body) or PERF_EN.search(body)):
        rep.add("HINT" if official else "WARN", W, "没看到任何表情或身体小反应（下颌、手指收紧、眨眼、屏息、重心…），人会像木头；细节清单第 4 条")
    for m in re.finditer(r"\b(in|with) (his|her|their) hands?\b|\bin hand\b|(她|他)?手里(拿着|捏着|握着)?|拿在手(里|上)", body, re.I):
        near = body[max(0, m.start() - 40):m.end() + 40]
        if not re.search(r"\b(left|right|both)\b|左手|右手|双手|两只手", near, re.I):
            rep.add("WARN", W, "「%s」没写左手还是右手；细节清单第 5 条" % m.group(0)); break


def detail_checks(rep, W, p, sec, dl, official=False, has_role=True):
    """细节清单（2026-11-08）。official=True（官方格式，v2026-11-23.1）只跑第 4、5 条：
    其余几条（dialogue 非空、六段字段、旧六段式、summary 太空、分秒时间段）是旧格式专属，官方格式有自己的 [官方·…] 检查，不在这里重复报。"""
    if official:
        kind_ = official_kind(p)
        _, secs_ = official_sections(p, OFFICIAL_FIELDS if kind_ == "ref" else BASE_FIELDS)
        body_ = secs_.get("detailed_description" if kind_ == "ref" else "integrated_multimodal_description", "")
        detail_body_checks(rep, W, body_, need_perf=has_role, official=True)  # 没有出镜角色的空镜、插入镜不查小反应
        return
    # 正文必须英文（2026-11-09 实测：整份队列写成中文，设定档英文句被翻成中文）
    nq = re.sub(r"[\"“”「」『』].*?[\"“”「」『』]", "", p)
    cjk = len(re.findall(r"[一-鿿]", nq)); lat = len(re.findall(r"[A-Za-z]", nq))
    # 2026-11-09.5 第一集对照：台词填进 dialogue 时，画布追加中文角色名 + 声音参考录音，角色喊自己名字、冒乱话。
    # 第一集正常写法：dialogue 留空，台词只写在正文「对白（中文普通话，口型同步）：」里，画布原样提交、不带声音。
    if dl:
        rep.add("ERROR", W, "dialogue 不是空的：画布会追加中文角色名和声音参考录音，角色会喊自己名字、说乱话。dialogue 留空 []，台词写进正文「对白（中文普通话，口型同步）：张三：“……” 李四：“……”」（get 提示词 第一集写法）")
    if re.search(r"\[参考生成|一条镜头拍完\]", p):
        rep.add("ERROR", W, "summary 标签用中文 [参考生成，一条镜头拍完] 会被念出来；改成 [reference generation, one continuous take]")
    for key in (("subject_definitions:", "summary:", "retention_analysis:", "detailed_description:", "overall_soundscape:", "non_diegetic_music:") if "subject_definitions:" in p else ()):
        if key not in p:
            rep.add("ERROR", W, "缺 %s 段（六段式字段名要用英文原样，不能写成中文如“配乐：”）" % key)
    sm = re.search(r"summary:(.*?)(retention_analysis:|$)", p, re.S)
    if "subject_definitions:" in p:
        rep.add("WARN", W, "用的是旧六段式；标准写法改为「第一集写法」（get 提示词 第一集写法）")
    if sm and len(re.sub(r"\[.*?\]", "", sm.group(1)).strip()) < 25:
        rep.add("WARN", W, "summary 太空，要一句话说清本镜事件（谁在哪做什么）")
    body = p.split("detailed_description:", 1)[-1]
    # 光线否定句 / 唯一光源、景别焦段、构图落点：2026-11-11 改为「每镜必写五项」ERROR，见 five_checks
    detail_body_checks(rep, W, body)
    segs = list(re.finditer(r"(\d{2}):\d{2}\s*-\s*(\d{2}):\d{2}(.*?)(?=\d{2}:\d{2}\s*-\s*\d{2}:\d{2}|$)", body, re.S))
    speak = [(int(m.group(2)) - int(m.group(1)), m.group(1)) for m in segs if re.search(r"\bspeaks\b|说那一?句|开口说|说话|说出|说台词|开口", m.group(3), re.I)]
    if dl and len(speak) == len(dl):
        for (dur, st), x in zip(speak, dl):
            n = len(re.findall(r"[一-鿿]", (x.get("text") or "") if isinstance(x, dict) else ""))
            if n and dur > 0 and n / float(dur) > 3.5:
                rep.add("WARN", W, "%s 秒起的说话段只有 %d 秒，台词 %d 字（%.1f 字/秒 > 3.5），会吞字；加长这一段或拆句" % (st, dur, n, n / float(dur)))


def first_sentence(p, key):
    m = re.search(re.escape(key) + r"(.*?[.。])(\s|$|[^.。]?)", p, re.S)
    return m.group(1).strip() if m else None


def consistency_checks(rep, shots):
    """项目设定档逐字复用（2026-11-08）：同队列同角色 Subject 句、风格块、同场景光线句要一致。"""
    subj, style, light = {}, {}, {}
    light_off = {}  # 官方格式：同一张场景图下，开头风格段里的光线句
    for i, s in enumerate(shots):
        if not isinstance(s, dict):
            continue
        p = s.get("prompt") or ""
        if is_official(p):
            # v2026-11-23.1（附录第 2 条）：官方格式的 Subject 句是 `<Subject 2> is Zhang San from <Picture 3>, a man …`，
            # 没有冒号；编号会随每镜的图数变，所以先把 <Picture N> / <Subject N> 抹成统一写法再比。只比人物，不比场景句。
            kind_, secs_, body_, sd_ = off_parts(p)
            for _, line in off_person_lines(sd_).items():
                m = re.match(r"\s*<Subject\s*\d+>\s+is\s+(.+?)\s+from\s+<Picture\s*\d+>", line)
                if m:
                    norm = re.sub(r"<(Picture|Subject|Audio)\s*\d+>", r"<\1>", line)
                    subj.setdefault(m.group(1).strip(), []).append((i, re.sub(r"\s+", " ", norm).strip()))
            intro_, _blocks = shot_blocks(body_)
            lt_ = " ".join(x for x in sentences(no_d(intro_)) if OFF_LIGHT_WORD.search(x))
            sc_ = (s.get("sceneAssetIds") or [None])[0] if isinstance(s.get("sceneAssetIds"), list) else None
            if lt_ and sc_:
                light_off.setdefault(sc_, {}).setdefault(re.sub(r"\s+", " ", lt_).strip(), []).append(i)
            continue
        sd = p.split("summary:", 1)[0]
        for m in re.finditer(r"<Subject \d+>:\s*([^,;，；]+)[,;，；](.*?)(?=<Subject \d+>:|<Picture \d+>|\n|$)", sd, re.S):
            subj.setdefault(m.group(1).strip(), []).append((i, re.sub(r"\s+", " ", m.group(2)).strip()))
        m = re.search(r"detailed_description:\s*(.*?\[style v[^\]]+\])", p, re.S)
        if m:
            style.setdefault(m.group(1).strip(), []).append(i)
        lt = first_sentence(p, "Light:") or first_sentence(p, "光线：") or first_sentence(p, "光线:")
        sc = (s.get("sceneAssetIds") or [None])[0]
        if lt and sc:
            light.setdefault(sc, {}).setdefault(lt, []).append(i)
    for name, lst in subj.items():
        vs = {}
        for i, t in lst:
            vs.setdefault(t, []).append(i + 1)
        if len(vs) > 1:
            rep.add("WARN", "一致性", "角色 %s 的 Subject 句有 %d 种写法（镜 %s）；从项目设定档逐字复制，换衣镜才另写" % (name, len(vs), " / ".join(",".join(map(str, v)) for v in vs.values())))
    if len(style) > 1:
        rep.add("WARN", "一致性", "风格块有 %d 种写法（镜 %s）；整集逐字复用一套" % (len(style), " / ".join(",".join(str(i + 1) for i in v) for v in style.values())))
    for sc, d in light.items():
        if len(d) > 1:
            rep.add("WARN", "一致性", "同一场景（%s…）的光线句有 %d 种写法（镜 %s）；同场逐字照抄" % (sc[:8], len(d), " / ".join(",".join(str(i + 1) for i in v) for v in d.values())))
    for sc, d in light_off.items():
        if len(d) > 1:  # 只提示：同一张场景图常被借去拍别的地方（会议室图拍走廊），光线句可以不同
            rep.add("HINT", "一致性", "[官方·光线] 同一张场景图（%s…）的开头风格段里光线句有 %d 种写法（镜 %s）；同一个地点要逐字照抄，借场景图拍别处可以不同" % (str(sc)[:8], len(d), " / ".join(",".join(str(i + 1) for i in v) for v in d.values())))


def first_style_checks(rep, W, p):
    """第一集写法。人名、禁声句、点名配乐都会被模型做成画面或声音。"""
    if re.search(r"开口|不出声|嘴唇闭着", p):
        rep.add("ERROR", W, "写了「开口 / 不出声 / 嘴唇闭着」。模型会把这句当台词念出来。台词只写在对白段；这一段嘴不说话就不要写嘴")
    if re.search(r"没有背景音乐|无背景音乐|不要背景音乐|没有配乐|无配乐|不要配乐|不要音乐|No background music|background music|soundtrack|musical score|non-diegetic music|\bany music\b|\bBGM\b", p, re.I):
        rep.add("ERROR", W, "正文点了背景音乐或配乐，包含「没有背景音乐」「No background music」。点名就会配上音乐。声音段只写房间底噪、对白和动作声")
    if "参考说明" not in p or "subject_definitions:" in p:
        return
    names = []
    for m in re.finditer(r"是([\u4e00-\u9fff]{2,4})[，,][^。\n]{0,40}只用于", p):
        if m.group(1) not in names:
            names.append(m.group(1))
    kept = []
    for line in p.splitlines():
        if line.startswith("参考说明") or line.startswith("对白") or line.startswith("画面要求"):
            continue
        if "秒" not in line and ("灯火" in line or "光照" in line or "灯光" in line):
            continue
        kept.append(line)
    blob = "\n".join(kept)
    hit = [n for n in names if n in blob]
    if hit:
        rep.add("ERROR", W, "人名 %s 出现在参考说明、对白和光线句以外，会被当成台词念出来。动作段、声音段、头发句改成他/她" % "、".join(hit))

# ---- 正本 v2026-11-11 / .1 / .2 并入的检查（2026-11-11）。只有确定违反正本的才 ERROR，靠猜的一律 HINT。----
NIGHT = re.compile(r"夜|night", re.I)
DAY = re.compile(r"白天|日光|阳光|正午|上午|下午|清晨|daylight|sunlight|midday|morning|afternoon", re.I)
WARM = re.compile(r"暖(黄|光|色|调|白)|钨丝|烛光|warm[- ](light|white|glow|yellow|amber|tungsten)|tungsten|amber light", re.I)
COLD = re.compile(r"冷白|冷光|冷色|冷蓝|蓝白|荧光|(cold|cool)[- ](white|light|blue)|fluorescent", re.I)
CROWD_FAST = re.compile(r"热闹|人潮|人流涌动|熙熙攘攘|摩肩接踵|energy high|high energy|bustling|crowd surges", re.I)
CROWD_SLOW = re.compile(r"慢步|慢慢走|缓步|慢走|踱步|slow|stroll", re.I)
DOOR_MOVE = re.compile(r"进门|出门|推门|跨进门|迈进门|迈出门|冲出门|冲进门|跑出门|跑进门|走出门|走进门|开门进|\b(enter|exit|burst|step|walk|run|rush)\w*\b[^.]{0,25}\bdoor", re.I)
DOOR_SIDE = re.compile(r"门内|门外|屋里|屋内|屋外|廊上|走廊|门口|门槛|室内|室外|inside|outside|doorway|threshold")
GARMENT = r"外套|西装|衬衫|裙|裤|领带|毛衣|大衣|T恤|上衣|睡衣|浴袍|纽扣|扣子|拉链|袍|衫"
CLOTH_STATE = re.compile(r"(%s)[^，。；\n]{0,8}?(扣好|扣着|解开|敞开|没扣|脱下|脱掉|没穿|穿着|穿上|披着|搭在|叠在|挂在|掉在|拉好|拉开)" % GARMENT)
CHANGE = re.compile(r"换衣|换上|换成|脱下|脱掉|穿上|解开|扣上|披上")


def light_part(p):
    """去掉对白行，正文里和光有关的行（第一集写法没有固定的光线字段）。"""
    keep = [ln for ln in p.splitlines() if not ln.startswith("对白") and re.search(r"光|灯|light|lamp|lit\b|sun|夜|白天", ln, re.I)]
    return "\n".join(keep)


def read_table_fields(path):
    """对照表每镜的 开始 / 结束 / 时间段 原文；没有对照表返回 {}。"""
    tp = os.path.splitext(path)[0] + "_对照表.md"
    if not os.path.exists(tp):
        return {}
    with open(tp, encoding="utf-8-sig") as f:
        txt = f.read()
    secs, cur = {}, None
    for line in txt.splitlines():
        m = re.match(r"^##\s+(.+?)\s*$", line)
        if m:
            cur = m.group(1); secs[cur] = []; continue
        if cur is not None:
            secs[cur].append(line)
    res = {}
    for t, lines in secs.items():
        body = "\n".join(lines); f_ = {}
        for k in ("开始", "时间段", "结束", "机位"):
            m = re.search(r"^\s*%s\s*[:：](.*?)(?=^\s*(?:%s)\s*[:：]|\Z)" % (k, "|".join(TABLE_FIELDS)), body, re.M | re.S)
            f_[k] = m.group(1).strip() if m else ""
        res[t] = f_
    return res


def zhengben_shot_checks(rep, W, s, p, gm):
    if gm == "extend" or s.get("sourceShot") or s.get("sourceVideoAssetId"):
        rep.add("ERROR", W, "视频延长（extend / sourceShot / sourceVideoAssetId）已停用，画布会报错；接续一律用 firstFrameFrom 接上一镜尾帧（正本 模式）")
    for sent in re.split(r"[。！？.!?\n]", p):
        if CROWD_FAST.search(sent) and re.search(r"人|crowd|people|行人|路人|宾客", sent, re.I) and not CROWD_SLOW.search(sent):
            rep.add("HINT", W, "人群写了「%s」却没写速度，远景人流容易渲成快跑；写「慢步走」（正本 细节 / 易错画面写法）" % CROWD_FAST.search(sent).group(0)); break
    body = re.sub(r"^对白[^\n]*", "", p, flags=re.M)
    if DOOR_MOVE.search(body) and not DOOR_SIDE.search(body):
        rep.add("HINT", W, "有进出门的动作（%s），但没写机位在门哪一侧、谁在门内谁在门外；门内的人写「站在门内，整镜不迈出门槛」（正本 细节 / 易错画面写法）" % DOOR_MOVE.search(body).group(0))
    if "参考说明" in p and "subject_definitions:" not in p:
        names = []
        for m in re.finditer(r"是([一-鿿]{2,4})[，,][^。\n]{0,40}?只用于", p):
            names.append(m.group(1))
        for line in p.splitlines():
            if not line.startswith("对白"):
                continue
            seg = line.split("：", 1)[-1] if "：" in line else line
            speakers = re.findall(r"(?:^|[\s”\"。！？])([一-鿿A-Za-z]{1,8})(?:[（(][^）)]*[）)])?[:：]\s*[“\"]", seg)
            for sp in speakers:
                if names and sp not in names:
                    rep.add("HINT", W, "对白里的「%s」在参考说明的「是…，只用于」里找不到，身份五项对不上（画外的人可以忽略）（正本 细节 / 身份五项）" % sp); break
            for q in re.findall(r"[“\"]([^”\"]+)[”\"]", seg):
                m = re.match(r"([一-鿿]{1,4})[，,]", q)
                if m and (m.group(1) in names or m.group(1) in speakers or any(n.endswith(m.group(1)) for n in names)):
                    rep.add("HINT", W, "台词以喊名字开头（「%s，…」），听着像旁白点名；剧本阶段可改口语，已批准的台词先问用户（正本 对白）" % m.group(1)); break


def zhengben_queue_checks(rep, shots, path, dfl, q):
    # 同一场景相邻两镜：日夜、冷暖相反（同一场景 = sceneAssetIds 第一张相同）
    prev = None
    for i, s in enumerate(shots):
        sc = (s.get("sceneAssetIds") or [None])[0] if isinstance(s.get("sceneAssetIds"), list) else None
        lp = light_part(s.get("prompt") or "")
        tod = ("夜" if NIGHT.search(lp) and not DAY.search(lp) else "白天" if DAY.search(lp) and not NIGHT.search(lp) else None)
        tone = ("暖" if WARM.search(lp) and not COLD.search(lp) else "冷" if COLD.search(lp) and not WARM.search(lp) else None)
        if prev and sc and prev[0] == sc:
            if tod and prev[1] and tod != prev[1]:
                rep.add("HINT", "一致性", "镜%d 和镜%d 是同一场景，光线一镜是%s、一镜是%s；同场要逐字复制同一句光线句，剧情真换了时间就当新场景并在对照表注明（正本 同场一致）" % (i, i + 1, prev[1], tod))
            if tone and prev[2] and tone != prev[2]:
                rep.add("HINT", "一致性", "镜%d 和镜%d 是同一场景，主光一镜偏%s、一镜偏%s；同场主色温要一致（正本 同场一致）" % (i, i + 1, prev[2], tone))
        prev = (sc, tod, tone) if sc else None
    # 对照表：服装状态写进 开始 / 结束，上一镜结束 = 下一镜开始（多镜队列才查）
    tab = read_table_fields(path)
    if tab and len(shots) >= 2:
        miss = []
        last = None
        for i, s in enumerate(shots):
            f_ = tab.get(s.get("title"))
            if not f_:
                last = None; continue
            if s.get("roleIds") and not (re.search(GARMENT, f_["开始"]) and re.search(GARMENT, f_["结束"])):
                miss.append(i + 1)
            st = set(CLOTH_STATE.findall(f_["开始"])); en = set(CLOTH_STATE.findall(f_["结束"]))
            sc = (s.get("sceneAssetIds") or [None])[0] if isinstance(s.get("sceneAssetIds"), list) else None
            if last and last[0] == sc and sc and last[1] and st:
                changed = CHANGE.search(f_["时间段"]) or re.search(r"换衣|换装|换了一套", f_["开始"])
                diff = [g + x for g, x in st if (g, x) not in last[1] and any(g == g2 for g2, _ in last[1])]
                if diff and not changed:
                    rep.add("HINT", "对照表 镜%d" % (i + 1), "开始的服装状态（%s）和上一镜结束对不上，又没写换衣；上一镜结束 = 下一镜开始（正本 细节 / 服装状态）" % "、".join(diff[:3]))
            last = (sc, en)
        if miss:
            rep.add("HINT", "对照表", "%d 镜的「开始」「结束」没写服装状态（镜 %s）；每个出镜人写颜色款式和扣好/解开/外套在哪（正本 细节 / 服装状态）" % (len(miss), ",".join(map(str, miss[:12])) + ("…" if len(miss) > 12 else "")))
    # 测试 / 小样一律 0.45（2026-11-11 用户定）
    name = (q.get("title") or "") + " " + os.path.basename(path)
    mp = dfl.get("megapixels")
    if re.search(r"测试|小样|试渲|打样|\btest\b", name, re.I) and is_num(mp) and abs(mp - 0.45) > 1e-6:
        rep.add("HINT", "defaults", "看标题/文件名是测试或小样，megapixels 是 %s；测试和小样一律 0.45（正本 流程 1）" % mp)


# ---- 每镜必写五项（正本 v2026-11-11.4，用户定：写不好就拦住）。ERROR 消息以 [五项·类别] 开头，画布按它分类拦截。----
F_STYLE, F_LIGHT, F_SHOT, F_COMP, F_CAM = "[五项·风格胶片]", "[五项·光线]", "[五项·景别焦段]", "[五项·构图]", "[五项·运镜机位]"
FILM = re.compile(r"Kodak|Fuji|Portra|Cinestill|Eterna|Vision\s?3|胶片|film grain|film stock|35mm film|16mm film|celluloid", re.I)
STOCK = re.compile(r"(Kodak\s*Vision\s*3\s*\d{2,3}\s*[DT]|Kodak\s*\d{2,3}\s*[DT]|Vision\s*3\s*\d{2,3}\s*[DT]|Portra\s*\d{3}|Cinestill\s*\d{2,3}\s*[DT]?|Fuji\w*\s*(Eterna\w*|\d{3}\w*)|Eterna\w*(\s*\d{3}\w*)?)", re.I)
SIZE_ZH = ["大特写", "特写", "中近景", "近景", "中全景", "中景", "大全景", "全景", "大远景", "远景"]
SIZE_EN = re.compile(r"extreme close.?up|close.?up|medium close.?up|medium shot|medium wide|wide shot|full shot|long shot|two.?shot|over.the.shoulder|establishing shot|chest.?up|waist.?up|from the waist up|head and shoulders|knees up|cowboy shot|full.?length|insert shot|aerial|establishing|macro|\bPOV\b|\bFPV\b|\b(extreme |very )?(wide|medium|close|full|long|tight)\b(?![- ]?angle)", re.I)
LENS = re.compile(r"\d{2,3}\s?mm|景深|虚化|焦段|浅焦|深焦|广角|长焦|等效|depth of field|deep focus|shallow focus|wide.?angle|telephoto|\blens\b|bokeh|out of focus|anamorphic|f/\d", re.I)
PLACE5 = re.compile(r"画左|画右|画中|画上|画下|画面左|画面右|画面中|画面上|画面下|居中|三分之一|黄金|left third|right third|upper third|lower third|golden|cent(re|er) of (the )?frame|frame.?left|frame.?right|screen.?left|screen.?right|left of (the )?frame|right of (the )?frame|placed (on|at|in) the|fill(s|ing)? the frame|in the middle of the frame|frame (left|right|centre|center)", re.I)
LAYER = {"前景": re.compile(r"前景|foreground", re.I), "中景": re.compile(r"中景(?!，?\s*\d)|midground|middle ground|mid-ground", re.I),
         "后景": re.compile(r"后景|背景|远处|background|behind (him|her|them)", re.I), "景深": re.compile(r"景深(只)?到|虚化|out of focus|soft(ly)? (blurred|out of focus)|bokeh", re.I)}
ANGLE = re.compile(r"平视|仰|俯|斜|侧面|侧拍|正面|背面|背后|过肩|四分之三|顶拍|贴地|低机位|高机位|镜头在|机位在|主观|对着|正对|(^|[，。\s])(低|高|侧|正|平)[，,]|eye.?level|low.?angle|high.?angle|overhead|top.?down|bird|worm|over.the.shoulder|three.?quarter|profile|from (a )?(low|high|behind|the side|above|below)|camera (is |sits |stays )?(at|on|behind|in front|low|high|above|below)|POV|FPV|aerial|reverse|(behind|above|below) (and (above|below) )?(its|his|her|the|them)\b|camera (starts|stays|sits|flies) (low|high)|\w+ level|looking (up|down)|(low|high) over|from (slightly |directly )?(above|below)|\w+ height\b|near side of|from (the )?(front|back)|behind (him|her|them)|(low|high) (two-shot|wide|medium|close|shot|camera|view|angle)", re.I)
MOVE = re.compile(r"固定|推|拉|跟|摇|横移|移动|升|降|环绕|手持|static|locked|fixed|push|pull|dolly|track|pan|tilt|crane|handheld|hand-held|orbit|follow|zoom|truck|pedestal|\barc\b|glide|descen|rise|drift|steadicam|dive|sweep|rack focus|swing", re.I)
CAM_STATIC = re.compile(r"机位固定|固定机位|镜头固定|固定不动|camera (is |stays |remains )?(completely )?(static|locked( off)?|fixed)|locked-off|static camera|fixed camera", re.I)
CAM_MOVING = re.compile(r"镜头(慢慢|缓缓|快速)?(推近|推向|拉远|拉开|跟拍|跟着|摇向|横移|环绕|升起|下降)|推镜|拉镜|跟拍|摇镜|环绕拍|手持跟|camera (slowly |quickly )?(pushes|pulls|dollies|tracks|pans|tilts|orbits|follows|cranes|glides|moves)|handheld|tracking shot|dolly (in|out)", re.I)
FORBID_LIGHT_NEG = re.compile(r"不(偏)?暗|不死黑|不发暗|不要.{0,4}暗")
FORBID_LIGHT_ONLY = re.compile(r"只有一盏|唯一的?光源")
SEGLINE = re.compile(r"^\s*\d+(\.\d+)?\s*[-–~]\s*\d+(\.\d+)?\s*秒|^\s*最终状态|^\s*\d{2}:\d{2}")


def five_text(p):
    """去掉参考说明、对白、声音、画面要求和「没有额外人物闯入」这类句子：五项只认镜头自己的描述。"""
    keep = []
    for ln in p.splitlines():
        if re.match(r"\s*(参考说明|对白|声音|画面要求)", ln):
            continue
        keep.append(ln)
    t = "\n".join(keep)
    t = re.sub(r"[^。.\n]*(No extra people|额外人物|主体保持在画面中央)[^。.\n]*[。.]?", "", t, flags=re.I)
    return t


def style_sentence(p):
    for sent in re.split(r"(?<=[。.])\s*|\n", p):
        if FILM.search(sent) and not re.match(r"\s*(参考说明|对白|声音|画面要求)", sent):
            return re.sub(r"\s+", " ", sent).strip()
    return None


def light_line(p):
    """第一集写法：光线那一行（不是分秒行）；旧六段式：Light: 开头那句。"""
    for ln in p.splitlines():
        if re.match(r"\s*(参考说明|对白|声音|画面要求|主要动作)", ln) or SEGLINE.match(ln):
            continue
        if re.search(r"灯|阳光|日光|月光|天光|窗光|烛|火光|光源|屏幕光|光线|主光|补光|逆光|\d{4}\s?K", ln):
            return ln.strip()
    m = re.search(r"\b(Light|Lighting)\s*:\s*[^\n]*?[.。]", p)
    if m:
        return m.group(0)
    m = re.search(r"[^.\n]*\b(lamp|lantern|sunlight|moonlight|daylight|candle|window light|key light|backlight|rim light|light from|sun|moon|light|lit|glow|\d{4}\s?K)\b[^.\n]*\.", p, re.I)
    return m.group(0) if m else None


def five_checks(rep, W, s, p):
    """每镜必写五项。只拦能可靠判断的：缺项、正本明令禁止的写法、同一句里自相矛盾。返回整集比对要用的数据。"""
    if not p.strip():
        return None
    t = five_text(p)
    # 1 风格胶片
    st = style_sentence(p)
    if not st:
        rep.add("ERROR", W, "%s 没有风格胶片句（如「写实真人电影质感，Kodak Vision3 250D 胶片颗粒，…」）；从设定档逐字复制，整集一句" % F_STYLE)
    # 2 光线
    lt = light_line(p)
    if not lt:
        rep.add("ERROR", W, "%s 没有光线句：写光源 + 位置/方向 + 色温（暖黄/冷白或数字 K）+ 亮在哪；同场从设定档逐字复制" % F_LIGHT)
    if FORBID_LIGHT_NEG.search(p):
        rep.add("ERROR", W, "%s 光线写了「不暗 / 不死黑」这类否定句，cfg=1 下反而把暗带进画面；改成正向写法（画面明亮通透、脸部均匀照亮）" % F_LIGHT)
    if FORBID_LIGHT_ONLY.search(p):
        rep.add("ERROR", W, "%s 写了「只有一盏灯 / 唯一光源」，会让画面大面积发暗；写清多个看得见的光源" % F_LIGHT)
    # 3 景别焦段
    zh = []
    rest = t
    for w in SIZE_ZH:
        if w in rest:
            zh.append(w); rest = rest.replace(w, "")
    has_size = bool(zh) or bool(SIZE_EN.search(t))
    if not has_size:
        rep.add("ERROR", W, "%s 没写景别（特写 / 近景 / 中近景 / 中景 / 全景 / 远景 之一，英文 close-up / medium shot / wide shot）" % F_SHOT)
    elif not LENS.search(t):
        rep.add("ERROR", W, "%s 写了景别但没写焦段或景深（如「35mm 等效，景深到两个人的脸」）" % F_SHOT)
    # 一镜一个主景别：机位那一句（同时有角度词和景别词的句子）里出现两个不同景别、又没写推拉变焦 → 矛盾
    for sent in re.split(r"[。\n]", t):
        ws = []
        r_ = sent
        for w in SIZE_ZH:
            if w in r_:
                ws.append(w); r_ = r_.replace(w, "")
        if len(set(ws)) >= 2 and ANGLE.search(sent) and not re.search(r"推|拉|变焦|到|→|从|转为|改为|或", sent):
            rep.add("ERROR", W, "%s 同一句机位里写了两个景别（%s），模型只能挑一个；一镜只留一个主景别，要变就写清从哪推到哪" % (F_SHOT, "、".join(ws))); break
    # 4 构图
    if not PLACE5.search(t):
        rep.add("ERROR", W, "%s 没写主体在画面哪里（画左 / 画右 / 画中 / 上三分之一，英文 left third / centre of frame）" % F_COMP)
    else:
        layers = [k for k, rx in LAYER.items() if rx.search(t)]
        if not layers:
            rep.add("ERROR", W, "%s 没写前中后景层次：至少写出前景 / 中景 / 后景（背景）里的两层，或写清景深到哪、后面虚化" % F_COMP)
    # 5 运镜机位
    if not ANGLE.search(t):
        rep.add("ERROR", W, "%s 没写机位高度或角度（平视 / 仰 / 俯 / 斜 / 侧面 / 镜头在桌沿下，英文 eye-level / low angle）" % F_CAM)
    if not MOVE.search(t):
        rep.add("ERROR", W, "%s 没写镜头怎么动（固定 / 推 / 拉 / 跟 / 摇，英文 static / push in / tracking）" % F_CAM)
    for sent in re.split(r"[。.\n]", t):
        if CAM_STATIC.search(sent) and CAM_MOVING.search(sent) and not re.search(r"然后|之后|再|随后|then|after|until|before|不|没有|never|no ", sent, re.I):
            rep.add("ERROR", W, "%s 同一句里镜头既「固定」又「%s」，互相矛盾；只留一种，要变就分时间段写" % (F_CAM, CAM_MOVING.search(sent).group(0))); break
    stock = STOCK.search(st or "")
    return {"style": st, "stock": re.sub(r"\s+", "", stock.group(0)).lower() if stock else None, "light": lt,
            "scene": (s.get("sceneAssetIds") or [None])[0] if isinstance(s.get("sceneAssetIds"), list) else None,
            "first": "参考说明" in p and "subject_definitions:" not in p}


def five_queue_checks(rep, shots, info):
    """风格胶片整集逐字一致（ERROR）；同场光线句不一致只提示（同一张场景图也会被走廊等别的地方借用）。"""
    idx = [(i, x) for i, x in enumerate(info) if x]
    stocks = {}
    for i, x in idx:
        if x["stock"]:
            stocks.setdefault(x["stock"], []).append(i)
    if len(stocks) > 1:
        main = max(stocks, key=lambda k: len(stocks[k]))
        for k, lst in stocks.items():
            if k == main:
                continue
            for i in lst:
                t = shots[i].get("title") or "?"
                rep.add("ERROR", "镜%d %s" % (i + 1, t[:30]), "%s 胶片型号是 %s，这一集大多数镜头是 %s；同一集只能一种，从设定档逐字复制" % (F_STYLE, k, main))
    styles = {}
    main_stock = max(stocks, key=lambda k: len(stocks[k])) if stocks else None
    for i, x in idx:
        if x["stock"] and main_stock and x["stock"] != main_stock:
            continue  # 胶片型号已经报过，不再重复报逐字不一致
        if x["first"] and x["style"]:
            styles.setdefault(x["style"], []).append(i)
    if len(styles) > 1:
        main = max(styles, key=lambda k: len(styles[k]))
        for k, lst in styles.items():
            if k == main:
                continue
            for i in lst:
                t = shots[i].get("title") or "?"
                rep.add("ERROR", "镜%d %s" % (i + 1, t[:30]), "%s 风格胶片句和这一集其他镜头不是逐字一致（大多数镜头是「%s」）；整集逐字复制同一句" % (F_STYLE, main[:40]))
    lights = {}
    for i, x in idx:
        if x["first"] and x["light"] and x["scene"]:
            lights.setdefault(x["scene"], {}).setdefault(re.sub(r"^光线[:：]", "", x["light"]).strip(), []).append(i + 1)
    for sc, d in lights.items():
        if len(d) > 1:
            rep.add("HINT", "一致性", "%s 同一组场景图（%s…）的光线句有 %d 种写法（镜 %s）；同一个地点要逐字照抄，借场景图拍别的地方（如走廊）可以不同" % (F_LIGHT, sc[:8], len(d), " / ".join(",".join(map(str, v)) for v in d.values())))


# ---- 本集设定（2026-11-11，正本 v2026-11-11.5；规则和画布 lib/episode-settings.ts 必须完全一样）----
EP_PH = re.compile(r"\{\{本集\.([^{}]*)\}\}")
EP_FIELDS = {"风格": "style", "画面要求": "frameRequirements", "光线": "lighting", "底声": "ambience"}
EP_KEYS = {"style", "frameRequirements", "lighting", "ambience"}
EP_RESIDUE = re.compile(r"\{\{|\}\}|｛｛|｝｝|本集\.")
EP_ANY = re.compile(r"\{\{|｛｛|本集\.")
EP_NUM = re.compile(r"<\s*(Picture|Subject|Audio)\s*\d+\s*>", re.I)
# 设定值里可能出现、展开后每镜都会命中的正文问题：(等级, 每镜消息开头, 判断函数)。命中设定的只报一次。
EP_CONTENT_RULES = [
    ("ERROR", "写了「开口 / 不出声 / 嘴唇闭着」", lambda t: re.search(r"开口|不出声|嘴唇闭着", t)),
    ("ERROR", "正文点了背景音乐或配乐", lambda t: re.search(r"没有背景音乐|无背景音乐|不要背景音乐|没有配乐|无配乐|不要配乐|不要音乐|No background music|background music|soundtrack|musical score|non-diegetic music|\bany music\b|\bBGM\b", t, re.I)),
    ("ERROR", "[五项·光线] 光线写了「不暗", lambda t: FORBID_LIGHT_NEG.search(t)),
    ("ERROR", "[五项·光线] 写了「只有一盏灯", lambda t: FORBID_LIGHT_ONLY.search(t)),
    ("WARN", "写了 no logos", lambda t: re.search(r"no (logos?|signs?|lettering|readable characters|written characters)\b|no logos or lettering|(不要|没有|不出现|去掉)[^。新]{0,6}(logo|标志|招牌|商标)", t, re.I)),
    ("WARN", "对白段以外的引号里有中文", lambda t: re.search(r"[\"“][^\"”]*[一-鿿][^\"”]*[\"”]", t)),
    ("HINT", "出现 glow/bloom/neon", lambda t: glow_hits(t) > 0),
]


def ep_items(ep):
    """本集设定里的每一项：[(占位名, 值)]，如 ('光线.办公室', '夜里…')。"""
    res = []
    if not isinstance(ep, dict):
        return res
    for zh, key in EP_FIELDS.items():
        v = ep.get(key)
        if isinstance(v, dict):
            for sc, val in v.items():
                res.append(("%s.%s" % (zh, sc), val))
        elif v is not None:
            res.append((zh, v))
    return res


def ep_lookup(ep, name):
    kind, _, scene = name.partition(".")
    value = (ep or {}).get(EP_FIELDS.get(kind, "")) if isinstance(ep, dict) else None
    if isinstance(value, dict):
        value = value.get(scene) if scene else None
    elif scene:
        value = None
    return value if isinstance(value, str) else None


def ep_available(ep):
    names = [n for n, v in ep_items(ep) if isinstance(v, str)]
    return "、".join(names) if names else "（本集设定是空的）"


def episode_prepare(rep, q, shots):
    """展开每镜 prompt 里的 {{本集.…}}（就地替换，之后所有检查看到的都是展开后的正文）。
    旧队列（没有 episode、哪里都没有 {{本集.）原样返回 None，结果和以前完全一样。返回 {镜号: 原模板} 和用法统计。"""
    ep = q.get("episode")
    blob = json.dumps(q, ensure_ascii=False)
    if ep is None and "{{本集." not in blob and "本集." not in blob and "｛｛本集" not in blob:
        return None
    # 1.3 第 3、4、5、6 条：设定本身
    if ep is not None and not isinstance(ep, dict):
        rep.add("ERROR", "本集设定", "episode 必须是对象，里面只能有 style / lighting / frameRequirements / ambience"); ep = {}
    ep = ep or {}
    extra = [k for k in ep if k not in EP_KEYS]
    if extra:
        rep.add("ERROR", "本集设定", "episode 里有不认识的键：%s（只能是 style / lighting / frameRequirements / ambience，拼错了会悄悄不生效）" % ", ".join(extra))
    for key in ("style", "frameRequirements"):
        if key in ep and not isinstance(ep[key], str):
            rep.add("ERROR", "本集设定", "episode.%s 必须是一段文字" % key)
    for key in ("lighting", "ambience"):
        if key in ep and not isinstance(ep[key], dict):
            rep.add("ERROR", "本集设定", "episode.%s 必须是 { 场景名: 句子 }" % key)
        elif key in ep:
            for sc, val in ep[key].items():
                if not sc or len(sc) > 20 or re.search(r"[\s.{}]", sc):
                    rep.add("ERROR", "本集设定", "episode.%s 的场景名「%s」不合格：不能为空、不超过 20 个字、不能有空格 . { }" % (key, sc))
                if not isinstance(val, str):
                    rep.add("ERROR", "本集设定.%s.%s" % ({"lighting": "光线", "ambience": "底声"}[key], sc), "设定值必须是一段文字")
    for name, val in ep_items(ep):
        if not isinstance(val, str):
            continue
        W = "本集设定.%s" % name
        if not val.strip():
            rep.add("ERROR", W, "设定值是空的")
        elif val != val.strip():
            rep.add("ERROR", W, "设定值开头或结尾有空格/换行（看不见的差别）；去掉")
        if EP_ANY.search(val) or "}}" in val or "｝｝" in val:
            rep.add("ERROR", W, "设定值里又有占位或「本集.」字样；不许套娃")
        if EP_NUM.search(val):
            rep.add("ERROR", W, "设定值里写了 %s；Picture / Subject / Audio 编号每镜不一样，提交时还会挪位，只能写在镜头自己的正文里" % EP_NUM.search(val).group(0))
    # 1.3 第 7 条：占位只能在镜头 prompt 里
    def walk(o, path):
        if isinstance(o, str):
            if EP_ANY.search(o):
                yield path
        elif isinstance(o, dict):
            for k, v in o.items():
                yield from walk(v, path + [k])
        elif isinstance(o, list):
            for i, v in enumerate(o):
                yield from walk(v, path + [i])
    for k, v in q.items():
        if k in ("chapters", "episode"):
            continue
        for pth in walk(v, [k]):
            rep.add("ERROR", "顶层", "%s 里写了 {{本集.…}}；占位只能写在镜头的 prompt 里" % ".".join(map(str, pth)))
    for ci, c in enumerate(q.get("chapters") or []):
        if isinstance(c, dict):
            for pth in walk(c.get("title"), ["title"]):
                rep.add("ERROR", "第%d章" % (ci + 1), "章标题里写了 {{本集.…}}；占位只能写在镜头的 prompt 里")
    templates, used = {}, {}
    for i, s in enumerate(shots):
        t = s.get("title") if isinstance(s.get("title"), str) else "?"
        W = "镜%d %s" % (i + 1, t[:30])
        for k, v in s.items():
            if k == "prompt":
                continue
            for pth in walk(v, [k]):
                rep.add("ERROR", W, "%s 里写了 {{本集.…}}；占位只能写在 prompt 里，别处会原样发给模型" % ".".join(map(str, pth)))
        p = s.get("prompt")
        if not isinstance(p, str) or "{{" not in p and "本集." not in p and "｛｛" not in p and "}}" not in p and "｝｝" not in p:
            continue
        bad = []

        def one(m):
            name = m.group(1)
            val = ep_lookup(ep, name)
            if val is None:
                bad.append(m.group(0)); return m.group(0)
            used.setdefault(name, []).append(i + 1)
            return val
        out = EP_PH.sub(one, p)
        for b in bad:
            rep.add("ERROR", W, "用了 %s，本集设定里没有；现有：%s" % (b, ep_available(ep)))
        if not bad and EP_RESIDUE.search(out):
            m = EP_RESIDUE.search(out)
            rep.add("ERROR", W, "展开后正文里还剩「%s」（%s），多半是占位括号写错了；正确写法 {{本集.光线.办公室}}" % (m.group(0), out[max(0, m.start() - 10):m.end() + 12].replace("\n", " ")))
        if EP_PH.search(p):
            templates[i] = p
            s["prompt"] = out
    # 提示：设定里有一项整集没人用
    for name, val in ep_items(ep):
        if isinstance(val, str) and name not in used:
            rep.add("HINT", "本集设定.%s" % name, "整集没有一镜用到这一项")
    return {"ep": ep, "templates": templates, "used": used}


def episode_near_miss(rep, shots, info):
    """提示：没用占位、逐字照抄的句子和本集设定差一点（改设定时会漏改）。"""
    import difflib
    ep = info["ep"]
    vals = [(n, v) for n, v in ep_items(ep) if isinstance(v, str) and v.strip()]
    if not vals:
        return
    for i, s in enumerate(shots):
        tpl = info["templates"].get(i)
        p = s.get("prompt") or ""
        lines = p.splitlines()
        cands = []
        for ln in lines:
            body = re.sub(r"^(光线|声音|画面要求)[:：]", "", ln.strip())
            cands.append(body)
            cands.extend(x + "。" for x in re.split(r"。", body) if x)
        for name, v in vals:
            if tpl and ("{{本集.%s}}" % name) in tpl:
                continue
            if any(v in c for c in cands):
                continue
            best = 0.0
            for c in cands:
                if abs(len(c) - len(v)) > max(8, len(v) * 0.2):
                    continue
                r = difflib.SequenceMatcher(None, c, v).ratio()
                best = max(best, r)
            if best >= 0.85:
                t = s.get("title") if isinstance(s.get("title"), str) else "?"
                rep.add("HINT", "镜%d %s" % (i + 1, t[:30]), "有一句和本集设定「%s」差一点（相似 %d%%）；要一致就改成 {{本集.%s}}，不一致是有意的就不用管" % (name, int(best * 100), name))


def episode_merge(rep, shots, info):
    """错误在设定里的只报一次：去掉每镜里由设定值引起的同一条，合并成「本集设定.X：…（N 镜用到）」。"""
    ep = info["ep"]
    for lvl, prefix, fn in EP_CONTENT_RULES:
        for name, val in ep_items(ep):
            if not isinstance(val, str) or not fn(val):
                continue
            users = info["used"].get(name, [])
            drop = set()
            for n in users:
                tpl = info["templates"].get(n - 1, "")
                if not fn(EP_PH.sub("", tpl)):
                    drop.add(n)
            keep = []
            for it in rep.items:
                m = re.match(r"镜(\d+) ", it[1])
                if m and int(m.group(1)) in drop and it[2].startswith(prefix):
                    continue
                keep.append(it)
            rep.items[:] = keep
            rep.add(lvl, "本集设定.%s" % name, "%s…（这句在本集设定里，%d 镜用到：镜 %s；改设定这一处就行）" % (prefix, len(set(users)), ",".join(str(x) for x in sorted(set(users))[:20]) + ("…" if len(set(users)) > 20 else "") if users else "无"))


def cmd_expand(d, a):
    """把用了本集设定的队列展开成旧格式（每镜正文逐字展开，去掉 episode），打到屏幕或 -o 文件。"""
    if not a:
        out("用法: expand <queue.json> [-o 输出.json]"); return 1
    with open(a[0], encoding="utf-8-sig") as f:
        q = json.load(f)
    rep = Rep()
    shots = [s for c in (q.get("chapters") or []) if isinstance(c, dict) for s in (c.get("shots") or []) if isinstance(s, dict)]
    info = episode_prepare(rep, q, shots)
    errs = [x for x in rep.items if x[0] == "ERROR"]
    if errs:
        for lvl, w, m in errs:
            out("%-5s %s：%s" % (lvl, w, m))
        out("有 ERROR，没有展开。"); return 2
    q.pop("episode", None)
    txt = json.dumps(q, ensure_ascii=False, indent=1)
    if "-o" in a and a.index("-o") + 1 < len(a):
        with open(a[a.index("-o") + 1], "w", encoding="utf-8", newline="\n") as f:
            f.write(txt + "\n")
        out("已展开 %d 镜（用了本集设定的 %d 镜），写到 %s" % (len(shots), len(info["templates"]) if info else 0, a[a.index("-o") + 1]))
    else:
        out(txt)
    return 0


# ---- 正本 v2026-11-11.6「时长怎么定」：镜头秒数和内容是否相符（2026-11-11）。只报 WARN，不拦截。----
# 给画布的约定：消息以「[时长] 偏长：」或「[时长] 偏短：」开头，结尾固定是「建议约 N 秒」（N 为 5～15 的整数），
# 画布用正则 建议约 (\d+) 秒 取 N，做「改成 N 秒」按钮。改格式前先通知画布。
DUR_SEG = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*[-–~～]\s*(\d+(?:\.\d+)?)\s*秒\s*[：:](.*)$", re.M)
DUR_SEG_EN = re.compile(r"(\d{2}):(\d{2})\s*-\s*(\d{2}):(\d{2})(.*?)(?=\d{2}:\d{2}\s*-\s*\d{2}:\d{2}|\n|$)", re.S)
DUR_SPEAK = re.compile(r"说话|开口|说出|说那一?句|说一句|说完那句|回(他|她|了)一句|\bspeaks?\b|\bspeaking\b", re.I)
# 停留词：这一小句只是保持原样，不算新变化
DUR_HOLD = re.compile(r"停在|停留|仍然?|依旧|依然|保持|留在|不动|还(是|在|按|贴|看|握|拿|搭|留|停|垂|放|靠|坐|站|挂|捏|攥)|一直(看|停|按|握|拿|站|坐)|(看|听|按|握|拿|搭|贴|坐|站|靠|挂|显示|垂|亮)着|显示在|挂在|是[“\"]|\b(still|stays?|remains?|keeps?|holds?|holding)\b", re.I)
# 大动作：一个约 1.5～2.5 秒，按 2 秒算
DUR_BIG = re.compile(r"推|拉|拿起|拿出|拿到|放下|放回|放到|放在|站起|起身|坐下|坐回|转身|转过|走|迈|跑|摊|抹|翻|抬起|托起|抬头|低头|转头|回头|递|交到|接过|打开|关上|靠回|靠过|坐姿|俯身|弯腰|伸手|伸向|伸到|按住|按下|勾|写|划|点一下|点了|敲|拨|拍|抱|扶|擦|倒|喝|刷新|换成|变成|亮起|熄灭|进门|出门|靠近|后退|退后|撑|扔|丢|捡|握住|抓住|攥住|松开|甩|掀|撕|折|收起|合上|扣上|解开|穿上|穿回|脱|褪|搭在|离开|\b(walks?|turns?|stands? up|sits? down|picks? up|puts? down|reaches|opens?|closes?|pushes|pulls|lifts?|lowers?|steps?|leans?|grabs?|hands?|takes?)\b", re.I)
# 小反应：约 0.75 秒
DUR_MICRO = re.compile(r"眨|屏|吞咽|下颌|下巴|眉|鼻翼|呼吸|嘴角|喉结|收紧|收拢|绷|抿|咬|眼神|瞥|看向|望向|抬眼|垂眼|点头|摇头|摇了|笑|皱|耸|吸一口气|呼出|颤|发抖|转一下|动一下|蜷|闪一下|\b(blinks?|swallows?|glances?|looks?|nods?|smiles?|frowns?|breath\w*|exhales?|inhales?|tightens?|jaw|brow)\b", re.I)
# 持续动作：本身就能填满时间（走路、抽送、晃动、飘落…），这一段按实写秒数算，最多 6 秒
DUR_CONT = re.compile(r"走到|走回|走向|走进|走出|走去|走来|绕过|经过|穿过|抽送|抽|顶入|顶回|一直在|不停|持续|还在(动|抽|走|晃|跑|飘|转)|继续(动|抽|走|晃|跑|飘|转|往)|晃|起伏|飘|流下|滴|走过|走向|跑向|越来越|更快|更慢|由.{1,4}到|\b(keeps? (moving|walking|thrusting)|continu\w+ to (move|walk)|drift\w*|sway\w*)\b", re.I)
DUR_NEG = re.compile(r"^(没|不|没有|未)|没有|不再|没人")


def dur_segments(p):
    segs = [(float(m.group(1)), float(m.group(2)), m.group(3).strip()) for m in DUR_SEG.finditer(p)]
    if not segs:
        body = p.split("detailed_description:", 1)[-1]
        segs = [(int(m.group(1)) * 60 + int(m.group(2)), int(m.group(3)) * 60 + int(m.group(4)), m.group(5).strip()) for m in DUR_SEG_EN.finditer(body)]
    return [s for s in segs if s[1] > s[0]]


def dur_lines(p, dl):
    """台词：第一集写法在正文「对白…：」行；旧写法在 dialogue。返回每句的汉字数。"""
    if dl:
        return [len(re.findall(r"[一-鿿]", x.get("text") or "")) for x in dl if isinstance(x, dict)]
    m = re.search(r"^\s*对白[^\n]*", p, re.M)
    return [len(re.findall(r"[一-鿿]", t)) for t in re.findall(r"[“\"]([^”\"]*)[”\"]", m.group(0))] if m else []


DUR_W = {"low": {"big": 1.5, "cont": 1.5, "micro": 0.5, "other": 0.0, "fill": 0.0, "floor": 1.0},   # 查偏短用下限
         "mid": {"big": 2.0, "cont": 2.0, "micro": 0.75, "other": 0.5, "fill": 4.0, "floor": 1.5},  # 建议秒数用中间值
         "high": {"big": 2.5, "cont": 2.5, "micro": 1.0, "other": 0.75, "fill": 6.0, "floor": 2.0}}  # 查偏长用上限
# floor = 有新变化的一段最少给多少秒（表演要时间）；同一句里第二个起的大动作多半是同一个连贯动作的后半截（伸手→拿起→交到左手），只算一半；fill = 持续动作那一段最多能占的秒数


def dur_clauses(text):
    """按人（句号/分号）拆，再按逗号拆小句。返回 [[(中间值权重, 种类)], ...]。"""
    out_ = []
    for sent in re.split(r"[。；;.!?！？]\s*", text):
        cl = []
        for c in re.split(r"[，,、]", sent):
            c = c.strip()
            if not c:
                continue
            if DUR_CONT.search(c):
                cl.append((2.0, "cont")); continue
            c0 = DUR_HOLD.sub("", c)
            if DUR_HOLD.search(c) and not DUR_BIG.search(c0):
                cl.append((0.0, "hold")); continue
            if DUR_NEG.search(c) and not DUR_BIG.search(c):
                cl.append((0.0, "hold")); continue
            if DUR_BIG.search(c):
                cl.append((2.0, "big"))
            elif DUR_MICRO.search(c):
                cl.append((0.75, "micro"))
            elif len(re.findall(r"[一-鿿A-Za-z]", c)) >= 4:
                cl.append((1.0, "other"))
            else:
                cl.append((0.0, "desc"))
        if cl:
            out_.append(cl)
    return out_


def dur_norm(t):
    t = DUR_HOLD.sub("", t)
    return re.sub(r"[\s，。、；：,.;:“”\"'（）()]", "", t)


def dur_similar(a, b):
    a, b = dur_norm(a), dur_norm(b)
    if not a or not b:
        return 0.0
    import difflib
    return difflib.SequenceMatcher(None, a, b).ratio()


def duration_estimate(p, dl, mode="mid"):
    """估这一镜需要多少秒（mode: low 下限 / mid 中间 / high 上限）。返回 (need, 明细)；正文没有分秒时间段返回 None。"""
    segs = dur_segments(p)
    if not segs:
        return None
    wt = DUR_W[mode]
    lines = dur_lines(p, dl)
    speak_idx = [k for k, s in enumerate(segs) if DUR_SPEAK.search(s[2])]
    seg_chars = {}
    for n, k in enumerate(speak_idx):
        if n < len(lines):
            seg_chars[k] = lines[n] if n < len(speak_idx) - 1 else sum(lines[n:])
    extra_chars = sum(lines) if lines and not speak_idx else 0
    info = {"segs": [], "actions": 0, "micro": 0, "chars": sum(lines), "stale": [], "stale_at": [], "gaps": []}
    need = 0.0
    for k, (a0, a1, txt) in enumerate(segs):
        dur = a1 - a0
        cls = dur_clauses(txt)
        kinds = [kind for sent in cls for w, kind in sent]
        nb = sum(1 for x in kinds if x in ("big", "cont"))
        info["actions"] += nb
        info["micro"] += sum(1 for x in kinds if x == "micro")
        sums = []
        for sent in cls:
            nbig = 0; tot = 0.0
            for w, kind in sent:
                if kind in ("big", "cont"):
                    tot += wt[kind] * (1.0 if nbig == 0 else 0.5); nbig += 1
                else:
                    tot += wt.get(kind, 0.0)
            sums.append(tot)
        sums = sums or [0.0]
        act = max(max(sums), 0.6 * sum(sums))  # 几句话有的同时、有的先后
        sim = dur_similar(txt, segs[k - 1][2]) if k > 0 else 0.0
        if k in seg_chars:
            sn = max(seg_chars[k] / 3.5, 2.0, act)  # 2026-11-18 去掉多留的 0.5 秒
            kind = "speak"
        elif "cont" in kinds:
            sn = max(min(dur, wt["fill"]), act)
            kind = "cont"
        elif k > 0 and (act == 0 or (sim >= 0.75 and nb == 0)):
            sn = min(dur, 2.0)
            kind = "stale"
            if dur > 3:
                info["stale"].append("%g-%g秒 %g 秒没有新变化（%s）" % (a0, a1, dur, "和上一段重复" if sim >= 0.75 else "只有停在/仍然/保持这类，没有新动作"))
                info["stale_at"].append("%g-%g秒" % (a0, a1))
        elif act == 0:
            sn = min(dur, 2.0)  # 开场交代画面
            kind = "open"
        else:
            sn = max(act, wt["floor"])
            kind = "act"
        info["segs"].append((a0, a1, kind, round(sn, 2)))
        info["gaps"].append((dur - sn, "%g-%g秒" % (a0, a1)))
        need += sn
    need += extra_chars / 3.5 + 0.5  # 收尾留 0.5 秒还在进行的动作
    return need, info


def duration_checks(rep, W, s, p, sec, dl):
    """正本「时长怎么定」。偏短看下限估计，偏长看上限估计，建议秒数用中间值。
    返回 None = 没估（正文没有时间段），"ok" = 估了没问题，"flag" = 报了偏长/偏短。"""
    if not is_num(sec) or not (5 <= sec <= 15):
        return None
    r = duration_estimate(p, dl, "mid")
    if r is None:
        return None
    mid, info = r
    low = duration_estimate(p, dl, "low")[0]
    high = duration_estimate(p, dl, "high")[0]
    roles = [x for x in (s.get("roleIds") or []) if x not in (s.get("offscreenRoleIds") or [])]
    clamp = lambda x: int(max(5, min(15, round(x))))
    what = []
    if info["actions"]:
        what.append("%d 个动作" % info["actions"])
    if info["micro"]:
        what.append("%d 个小反应" % info["micro"])
    what = "、".join(what)
    if info["chars"]:
        what = (what + " + " if what else "") + "%d 字台词" % info["chars"]
    what = what or "只有画面交代"
    if low - sec >= 2:
        n = max(clamp(mid), clamp(low), int(min(15, sec + 1)))
        tail = "，15 秒也放不下，要拆镜" if low > 15.5 else ""
        rep.add("WARN", W, "[时长] 偏短：%s 挤在 %g 秒（估计至少要约 %g 秒%s）；建议约 %d 秒" % (what, sec, round(low, 1), tail, n))
        return "flag"
    n = clamp(mid)
    # 偏长 = 掺水。有戏的镜头（有出镜角色）给两个方向：保留时长把空档补成有内容的，或缩短；插入镜/空镜只建议缩短。
    reasons = list(info["stale"])
    insert = not roles
    if insert and sec > 6 and mid <= 6.5:
        reasons.append("没有角色的插入镜写了 %g 秒，一般 5～6 秒就够" % sec)
        n = min(n, 6)
    if sec - high >= 3 and not info["stale"]:
        reasons.append("%s 估计只要约 %g 秒，写了 %g 秒，有空档模型会自己编动作" % (what, round(mid, 1), sec))
    if reasons and n < sec:
        if insert:
            fix = "缩短"
        else:
            gaps = sorted(info["gaps"], reverse=True)
            where = info["stale_at"] or [g[1] for g in gaps if g[0] >= 1.5][:2] or [gaps[0][1]]
            where = "、".join(sorted(where, key=lambda x: float(x.split("-")[0])))
            fix = "要么保留 %g 秒，把 %s 补成有内容的（加一个看得见的动作、反应、表情变化或机位变化）；要么缩短" % (sec, where)
        rep.add("WARN", W, "[时长] 偏长：%s；%s，建议约 %d 秒" % ("；".join(reasons), fix, n))
        return "flag"
    return "ok"

# ---- 正本 v2026-11-11.9「同性别角色怎么区分」（2026-11-11）。用户确认动作段可以用 <Picture N> 称呼角色（原话：「<Picture 2>可以的」）。----
# 性别从哪来：参考说明那一句写了男人/女人就听它；否则看整份队列里只有这一个角色出镜的镜头，正文只用「他」还是只用「她」；
# 再用一男一女同框的镜头补齐。推不出来的角色不报。
G_MALE = re.compile(r"男人|男孩|男生|男子|男性|先生|\d+岁男|老头|大叔")
G_FEMALE = re.compile(r"女人|女孩|女生|女子|女性|小姐|\d+岁女|老太|阿姨")
G_ROLEREF = re.compile(r"<Picture\s*(\d+)>\s*是([一-鿿]{2,4})[，,]([^；;。\n]{0,80}?)只用于([^；;。\n]{0,30})")
G_NUMREF = re.compile(r"<Picture\s*(\d+)>\s*里的(男人|女人|男孩|女孩|人)")


def g_body_lines(p):
    """动作段、声音段、风格场景句（参考说明、对白、画面要求以外）。"""
    return [ln for ln in p.splitlines() if ln.strip() and not re.match(r"\s*(参考说明|对白|画面要求)", ln)]


def g_pron(text):
    t = re.sub(r"其他|其它|他们|她们|他人", "", text)
    return t.count("他"), t.count("她")


def g_people(s, p):
    """返回本镜出镜角色 [(Picture 编号, 名字, roleId 或 None, 参考说明里写的性别 或 None)]。"""
    roles = [x for x in (s.get("roleIds") or []) if is_id(x)]
    off = s.get("offscreenRoleIds") or []
    ref = next((ln for ln in p.splitlines() if ln.strip().startswith("参考说明")), "")
    out_ = []
    k = 0
    for m in G_ROLEREF.finditer(ref):
        name, rest, use = m.group(2), m.group(3), m.group(4)
        if "场景" in name or "图" in name or not re.search(r"脸|发型|外观|服装|长相", use):
            continue
        rid = roles[k] if k < len(roles) else None
        k += 1
        if rid in off:
            continue
        g = "男" if G_MALE.search(rest) else ("女" if G_FEMALE.search(rest) else None)
        out_.append((int(m.group(1)), name, rid, g))
    return out_


def gender_checks(rep, shots):
    data = []
    for i, s in enumerate(shots):
        p = s.get("prompt") if isinstance(s.get("prompt"), str) else ""
        if "参考说明" not in p or "subject_definitions:" in p:
            data.append(None); continue
        data.append((g_people(s, p), "\n".join(g_body_lines(p))))
    sex = {}  # 名字 → 男/女

    def key(pp):
        return pp[1]
    for d in data:
        for pp in (d[0] if d else []):
            if pp[3]:
                sex.setdefault(key(pp), pp[3])
    votes = {}
    for d in data:
        if d and len(d[0]) == 1 and not d[0][0][3]:
            he, she = g_pron(d[1])
            if bool(he) != bool(she):
                votes.setdefault(key(d[0][0]), set()).add("男" if he else "女")
    for k, v in votes.items():
        if len(v) == 1:
            sex.setdefault(k, v.pop())
    for _ in range(2):  # 一男一女同框：知道一个就知道另一个
        for d in data:
            if d and len(d[0]) == 2:
                he, she = g_pron(d[1])
                a, b = d[0]
                if he and she:
                    if key(a) in sex and key(b) not in sex:
                        sex[key(b)] = "女" if sex[key(a)] == "男" else "男"
                    elif key(b) in sex and key(a) not in sex:
                        sex[key(a)] = "女" if sex[key(b)] == "男" else "男"
    # 多人同框、正文用「…的男人」这类外貌称呼时：男人称呼的种数够数、正文又没有「女人」，剩下推不出的人就是男的（女的同理）
    for d in data:
        if not d or len(d[0]) < 2:
            continue
        unk = [pp for pp in d[0] if key(pp) not in sex]
        if not unk:
            continue
        he, she = g_pron(d[1])
        for g, word, other, pc, opc in (("男", "男人", "女人", he, she), ("女", "女人", "男人", she, he)):
            known_g = sum(1 for pp in d[0] if sex.get(key(pp)) == g)
            known_o = sum(1 for pp in d[0] if sex.get(key(pp)) and sex.get(key(pp)) != g)
            kinds = set(re.findall(r"([一-鿿]{1,10}?)的(?:年长|年轻)?%s" % word, d[1]))
            if other not in d[1] and len(kinds) >= known_g + len(unk) and (opc == 0 or known_o >= 1):
                for pp in unk:
                    sex[key(pp)] = g
                break
    for i, d in enumerate(shots):
        if not data[i]:
            continue
        people, body = data[i]
        t = d.get("title") if isinstance(d.get("title"), str) else "?"
        W = "镜%d %s" % (i + 1, t[:30])
        pics = {pp[0]: pp for pp in people}
        p = d.get("prompt")
        ref = next((ln for ln in p.splitlines() if ln.strip().startswith("参考说明")), "")
        used = {}
        for m in G_NUMREF.finditer(body):
            n, who = int(m.group(1)), m.group(2)
            if n in used:
                continue
            used[n] = who
            if n not in pics:
                what = "场景图" if re.search(r"<Picture\s*%d>\s*是[^；;。\n]{0,20}场景" % n, ref) else "参考说明里没有这个编号的角色"
                rep.add("ERROR", W, "[编号] 正文写了「<Picture %d>里的%s」，但 <Picture %d> 不是出镜角色的参考图（%s）。编号要和参考说明「<Picture N>是X，只用于X的脸…」对上（正本 同性别角色怎么区分）" % (n, who, n, what))
            else:
                g = sex.get(key(pics[n]))
                if g and who in ("男人", "男孩", "女人", "女孩") and who[0] != g:
                    rep.add("WARN", W, "[编号] 正文写「<Picture %d>里的%s」，但 <Picture %d> 是%s，看前后镜是%s的；核对编号有没有写串（正本 同性别角色怎么区分）" % (n, who, n, pics[n][1], g))
        for g, word, pron in (("男", "男人", "他"), ("女", "女人", "她")):
            same = [pp for pp in people if sex.get(key(pp)) == g]
            if len(same) < 2:
                continue
            nums = [pp[0] for pp in same]
            miss = [n for n in nums if n not in used]
            he, she = g_pron(body)
            cnt = he if pron == "他" else she
            if miss and len(miss) == len(nums):
                rep.add("HINT", W, "这一镜有 %d 个%s同框（%s），动作段只写「%s」或外貌描述，模型分不清谁是谁；改成「%s」，每次用同一个编号，站位全镜不对调（正本 同性别角色怎么区分）" % (len(same), word, "、".join("<Picture %d>是%s" % (pp[0], pp[1]) for pp in same), pron, "」「".join("<Picture %d>里的%s" % (n, word) for n in nums)))
            elif miss or cnt:
                rep.add("HINT", W, "这一镜 %d 个%s同框，编号和「%s」混着用（%s）；同性别同框时每次都写「<Picture N>里的%s」，不要一会儿编号一会儿「%s」（正本 同性别角色怎么区分）" % (len(same), word, pron, ("<Picture %s> 没用编号" % ",".join(map(str, miss))) if miss else "还有 %d 处「%s」" % (cnt, pron), word, pron))


# ---- 正本 v2026-11-12「什么时候用接尾帧」（2026-11-12）。只给 HINT，拿不准就不报。----
# 给画布的约定：消息固定为「[接尾帧] 可以考虑接上一镜尾帧：<上一镜完整标题> → <这一镜完整标题>；理由：…」，
# 标题是队列里的 title 原文（不截断），中间是「 → 」（空格、U+2192、空格）。改格式前先通知画布。
T_SHOT = re.compile(r"大特写|特写|中近景|中全景|大远景|近景|中景|全景|远景")
T_ANGLE = re.compile(r"平视|仰拍|仰视|仰|俯拍|俯视|俯|侧面|侧|斜|过肩|主观|低机位|高机位|桌沿下")
T_MM = re.compile(r"(\d{2,3})\s*mm")
T_MOVE = re.compile(r"固定|推近|推|拉远|拉|摇|跟拍|跟|手持|环绕|升|降")
T_SIDE = re.compile(r"(他|她|<Picture\s*\d+>里的(?:男人|女人)|[一-鿿]{0,4}男人|[一-鿿]{0,4}女人)[^，。；\n]{0,3}?(?:在|坐在|站在|留在|跪在|躺在|靠在)?(画左|画右|画中)")
T_POSE = re.compile(r"坐|站|跪|躺|蹲|趴|靠")
T_HOLD = re.compile(r"(左手|右手|双手)[^，。；\n]{0,8}?(?:拿着|握着|捏着|攥着|举着|拎着|夹着|拿|握|捏|攥|举|拎|按在|按着)([一-鿿]{1,6})")
T_MAX_RUN = 3  # 一条接尾帧链最多连接 3 次（4 镜），再往后建议回全能参考（🧪 经验值）
T_CLOTH_W = {"扣好": "扣好", "扣着": "扣好", "解开": "解开", "敞开": "解开", "脱掉": "脱掉", "已脱": "脱掉", "脱下": "脱掉"}
T_CLOTH = re.compile("|".join(T_CLOTH_W))


def t_cloth(text):
    return set(T_CLOTH_W[w] for w in T_CLOTH.findall(text or ""))


T_SEG = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*[-–~～]\s*(\d+(?:\.\d+)?)\s*秒\s*[：:](.*)$", re.M)


def t_camera(p, tab):
    """机位那句：对照表「机位：」写了景别和角度就用它，否则取正文里写机位景别的小句。"""
    txt = (tab or {}).get("机位", "")
    if not (T_SHOT.search(txt) and T_ANGLE.search(txt)):
        cl = [c for c in re.split(r"[，。,；\n]", five_text(p)) if T_SHOT.search(c) or T_ANGLE.search(c) or T_MM.search(c) or "机位" in c]
        txt = "，".join(cl)
    return txt, (frozenset(T_SHOT.findall(txt)), frozenset(T_ANGLE.findall(txt)), frozenset(T_MM.findall(txt)))


def t_state(text):
    side = {}
    for m in T_SIDE.finditer(text):
        side.setdefault(m.group(1), set()).add(m.group(2))
    hold = set((h, o) for h, o in T_HOLD.findall(text))
    pose = set(T_POSE.findall(text))
    return side, hold, pose


def t_end_start(p, tab):
    segs = list(T_SEG.finditer(p))
    fin = re.search(r"^\s*最终状态[：:](.*)$", p, re.M)
    end = " ".join(x for x in ((tab or {}).get("结束", ""), fin.group(1) if fin else "", segs[-1].group(3) if segs else "") if x)
    first = segs[0].group(3) if segs else ""
    lines = [ln for ln in p.splitlines() if ln.strip() and not re.match(r"\s*(参考说明|对白|声音|画面要求|主要动作|最终状态|光线)", ln) and not T_SEG.match(ln)]
    start = " ".join(x for x in ((tab or {}).get("开始", ""), " ".join(lines), first) if x)
    return end, start


def t_conflict(e, st):
    """结束和开始的站位 / 姿势 / 手里拿的东西是否对得上。返回 (对得上, 理由列表)。"""
    es, eh, ep = t_state(e)
    ss_, sh, sp = t_state(st)
    common = [w for w in es if w in ss_]
    if not common:
        return False, []
    for w in common:
        if not (es[w] & ss_[w]):
            return False, []
    if ep and sp and not (ep & sp):
        return False, []
    for hand, obj in eh:
        other = [o for h_, o in sh if h_ == hand]
        if other and obj not in other:
            return False, []
    why = ["站位接得上（%s）" % "、".join("%s在%s" % (w, "/".join(sorted(es[w] & ss_[w]))) for w in common)]
    if ep & sp:
        why.append("姿势一样（%s）" % "/".join(sorted(ep & sp)))
    hh = [(h_, o) for h_, o in eh if (h_, o) in sh]
    if hh:
        why.append("%s还%s" % hh[0])
    return True, why


# ---- 正本 v2026-11-12.2「有台词的镜头，第一句前不能有超过 1 秒的空白」（用户 2026-11-12 定）----
# 给画布的约定：ERROR 消息固定为「[开场空白] <镜头完整标题>：有台词，但第一句说话在第 N 秒才开始（开头空了 N 秒）。按剧情选一种改：①第一句挪到 0～1 秒内开始；②开头这段沉默 / 动作拆成单独一个不带台词的镜头；③挪进上一镜结尾」。
# 说话词比画布 h3-prompt.ts 的 SPEAKS 全（含「说完」）；前面带 不 / 没 / 别 的不算；判断不了（没有时间段、找不到说话段）不报。
GAP_SPEAK = re.compile(r"说话|说道|问道|答道|开口|回答|说完|接着说|说出|说一句|说那一?句|问一句|回一句|回了一句|应一声|应了一声|念|喊|\bspeaks?\b|\bspeaking\b|\bsays?\b|\basks?\b|\banswers?\b", re.I)
GAP_NOT = re.compile(r"(?:不|没|别|没有|不再)(?:说话|开口|回答|说完|说出|念|喊)|已经说完|已说完|听[^，。；]{0,6}说完")
GAP_MAX = 1.0


def opening_gap_checks(rep, shots):
    for i, s in enumerate(shots):
        p = s.get("prompt") if isinstance(s.get("prompt"), str) else ""
        if not re.search(r"^\s*对白\s*[（(]", p, re.M):
            continue  # 没台词的镜头不报
        segs = sorted(dur_segments(p))
        if not segs:
            continue
        first = next((a for a, b, t in segs if GAP_SPEAK.search(GAP_NOT.sub("", t))), None)
        if first is None or first <= GAP_MAX:
            continue
        t = s.get("title") or ""
        n = ("%g" % first)
        rep.add("ERROR", "镜%d %s" % (i + 1, t[:30]), "[开场空白] %s：有台词，但第一句说话在第 %s 秒才开始（开头空了 %s 秒）。按剧情选一种改：①第一句挪到 0～1 秒内开始；②开头这段沉默 / 动作拆成单独一个不带台词的镜头；③挪进上一镜结尾" % (t, n, n))


# ---- 正本 v2026-11-12.4「有台词的镜头里，没人说话的时间段不写画面上能读出来的字」（用户 2026-11-12 定）----
# 证据（实测）：一镜会议室戏 7-9 秒没有台词，正文写了屏幕上的数字和字样，4 条出片这一段全都多出人声（念屏幕上的字）。
# 给画布的约定：ERROR 消息固定为「[念字] <镜头完整标题>：<秒段> 没有台词，但写了能读出来的字「…」「…」，模型会念出来。改法：…」。拿不准的报 WARN，前缀同样是 [念字]。
# 哪一段没有台词：复用 [开场空白] 的分段（dur_segments）和说话判断（GAP_SPEAK / GAP_NOT）。
# 先抹掉不算字的东西：<Picture N>、{{本集.xx}}、秒段标记、带单位的数（3 秒、35mm、1.5 倍、f/2.8）、物品名（T 恤、U 盘、LED…）
NZ_STRIP = re.compile(r"<Picture\s*\d+>|\{\{[^}\n]*\}\}|\d+(?:\.\d+)?\s*[-–~～]\s*\d+(?:\.\d+)?\s*秒|(?:f/)?\d+(?:\.\d+)?\s*(?:秒|毫米|厘米|mm|cm|fps|米|倍|度|°|帧|格|步|拍)|f/\d+(?:\.\d+)?|T\s*恤|V\s*领|U\s*[盘型]|L\s*型|A[34]\s*纸|(?<![A-Za-z0-9])(?:LED|USB|PPT|POV|iPad|iPhone|Wi-?Fi|logo|App)(?![A-Za-z0-9])", re.I)
NZ_QUOTE = re.compile(r"[“\"「『]([^“”\"「」『』\n]{1,40})[”\"」』]")
NZ_LATIN = re.compile(r"(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9]*(?:[-_./][A-Za-z0-9]+)*")
NZ_NUM = re.compile(r"(?<![\d.])\d+(?:\.\d+)+%?|(?<![\d.])\d+%")
NZ_INT = re.compile(r"(?<![\d.A-Za-z第])(?<!第 )\d+(?![\d.%A-Za-z])(?!\s*[一-鿿])")
# 载体词：同一句里有这些词，说明字是写在屏幕 / 白板 / 文件 / 招牌 / 表盘上的
NZ_CARRIER = re.compile(r"屏幕|大屏|屏上|屏里|显示|投影|幕布|白板|黑板|文件|纸上|稿|报告|表格|图表|曲线|招牌|牌子|门牌|标牌|标签|表盘|仪表|页面|界面|弹窗|字幕|标题|数字|数值|字样|文字|字母|写着|印着|标着|刻着|[左右]上角|[左右]下角")
NZ_SENT = re.compile(r"[^。！？；;!?\n]+")
NZ_FIX = "把这些字从这一段删掉，改成「看着屏幕」「盯着那块数字」这类不带具体字的说法；屏幕、文件上是什么内容，只在前面风格场景那一句交代一次"


def nz_scan(text):
    """在一段正文里找能读出来的字。返回 [(位置, 字, 有没有把握)]。
    有把握：带小数点的数字、百分数；和屏幕 / 白板 / 文件这类词在同一句里的英文字母、型号、引号里的字。
    没把握：没有载体词的英文字母和引号；载体词旁边、后面不跟量词的整数。"""
    def blank(m):
        return " " * len(m.group(0))

    def carrier(pos):
        for m in NZ_SENT.finditer(text):
            if m.start() <= pos < m.end():
                return bool(NZ_CARRIER.search(m.group(0)))
        return False

    t = NZ_STRIP.sub(blank, text)
    found = []
    for rx, kind in ((NZ_QUOTE, "q"), (NZ_LATIN, "w"), (NZ_NUM, "n"), (NZ_INT, "i")):
        for m in rx.finditer(t):
            w = (m.group(1) if kind == "q" else m.group(0)).strip()
            if not w:
                continue
            near = carrier(m.start())
            if kind == "i" and not near:
                continue  # 普通整数（数量）不报
            found.append((m.start(), w, kind == "n" or (near and kind != "i")))
        t = rx.sub(blank, t)
    return sorted(found)


def read_aloud_checks(rep, shots):
    for i, s in enumerate(shots):
        p = s.get("prompt") if isinstance(s.get("prompt"), str) else ""
        if not re.search(r"^\s*对白\s*[（(]", p, re.M):
            continue  # 整镜没有台词的镜头（插入镜、屏幕特写）不归这条管
        segs = sorted(dur_segments(p))
        if not segs:
            continue
        talk = [bool(GAP_SPEAK.search(GAP_NOT.sub("", t))) for a, b, t in segs]
        sure = any(talk)  # 一段说话都找不到：分不清哪段没台词，只报 WARN
        title = s.get("title") or ""
        W = "镜%d %s" % (i + 1, title[:30])
        for (a, b, t), sp in zip(segs, talk):
            if sp or not re.search(r"[一-鿿]", t):
                continue  # 说话段不查；纯英文段判断不了
            strong, weak = [], []
            for _, w, k in nz_scan(t):
                lst = strong if k else weak
                if w not in strong and w not in weak:
                    lst.append(w)
            span = "%g-%g秒" % (a, b)
            if strong and sure:
                rep.add("ERROR", W, "[念字] %s：%s 没有台词，但写了能读出来的字%s，模型会念出来。改法：%s" % (title, span, "".join("「%s」" % w for w in strong[:6]), NZ_FIX))
            elif strong:
                rep.add("WARN", W, "[念字] %s：%s 里有能读出来的字%s，但这一镜哪段在说话没写清楚（没有一段写「说话」）。这一段如果没有台词，模型会把这些字念出来：%s；如果这一段有台词，就在这一段写上「说话」" % (title, span, "".join("「%s」" % w for w in strong[:6]), NZ_FIX))
            if weak:
                rep.add("WARN", W, "[念字] %s：%s 没有台词，里面有%s。如果这是画面上能读出来的字，模型可能会念出来，是的话%s；如果只是物品的名字、不是画面上的字，可以不管" % (title, span, "".join("「%s」" % w for w in weak[:6]), NZ_FIX))


def tail_checks(rep, chs, path):
    """[接尾帧] HINT：同章相邻、同场景图、同一组人、机位景别不变、结束接得上开始、这一镜还没接帧。拿不准就不报。"""
    tab = read_table_fields(path)
    gi = 0
    for c in chs:
        ss = [x for x in (c.get("shots") if isinstance(c, dict) else None) or [] if isinstance(x, dict)]
        run = 0  # 到上一镜为止已经连着接了几次（已写的 + 这里建议的）
        for k, (a, b) in enumerate(zip(ss, ss[1:])):
            i = gi + k + 1
            if b.get("firstFrameFrom"):
                run += 1; continue  # 已经接了，不报
            linked, run = run, 0
            if any(b.get(x) for x in ("firstFrameAssetId", "lastFrameFrom", "lastFrameAssetId", "timeAnchors")):
                continue
            if b.get("generationMode") in ("first-last", "extend"):
                continue
            sa, sb = [x for x in a.get("sceneAssetIds") or [] if is_id(x)], [x for x in b.get("sceneAssetIds") or [] if is_id(x)]
            ra, rb = set(x for x in a.get("roleIds") or [] if is_id(x)), set(x for x in b.get("roleIds") or [] if is_id(x))
            if not sa or not sb or sa[0] != sb[0] or not rb or ra != rb:
                continue  # 换地点 / 换人：正本规定回全能参考
            if set(a.get("offscreenRoleIds") or []) != set(b.get("offscreenRoleIds") or []):
                continue
            ta, tb = a.get("title") or "", b.get("title") or ""
            if re.search(r"反打|过肩|主观|插入|空镜", ta + tb):
                continue
            pa, pb = a.get("prompt") or "", b.get("prompt") or ""
            (txa, ka), (txb, kb_) = t_camera(pa, tab.get(ta)), t_camera(pb, tab.get(tb))
            if not ka[0] or not ka[1] or ka != kb_:
                continue  # 景别 / 角度 / 焦段变了，就是切镜
            if dur_similar(txa, txb) < 0.85:
                continue
            e, _ = t_end_start(pa, tab.get(ta))
            _, st = t_end_start(pb, tab.get(tb))
            ok, why = t_conflict(e, st)
            if not ok:
                continue
            ea, sb_ = t_cloth((tab.get(ta) or {}).get("结束") or e), t_cloth((tab.get(tb) or {}).get("开始") or st)
            if "换衣" in ((tab.get(tb) or {}).get("开始", "") + pb) or (ea and sb_ and not (ea & sb_)):
                continue  # 服装状态变了（上一镜穿着、这一镜已脱），尾帧会把旧衣服带过来
            if linked >= T_MAX_RUN:
                continue  # 已经连着接了 3 次，这一镜回全能参考，免得瑕疵越积越多
            run = linked + 1
            why =["同一场景图、同一组人", "机位景别一样（%s）" % re.sub(r"[。.]\s*$", "", txb.strip())[:30]] + why
            rep.add("HINT", "镜%d %s" % (i + 1, tb[:30]), "[接尾帧] 可以考虑接上一镜尾帧：%s → %s；理由：%s。接上就在这一镜写 firstFrameFrom 上一镜 last（generationMode first-last）；代价是上一镜的瑕疵会带进来、要等上一镜出完再排（正本 什么时候用接尾帧）" % (ta, tb, "，".join(why)))
        gi += len(ss)


# ---- 正本 v2026-11-13 / .1「官方格式」（用户 2026-11-13 定：「既然测试出来官方的是正确的，那就用官方的」「旧格式不用了」）----
# 证据：实测对比（同人同图同种子，官方格式干净）。出处：MiniMax H3 官方 Ref2VA 写作指南（六段式）
# 和 base-en.txt（T2VA / I2VA / FL2VA / L2VA 三栏式）。
# 给画布的约定：官方格式的消息一律以 [官方·xx] 开头（类型 / 六栏 / 三栏 / 对齐句 / Subject / 台词 / 切镜 / 声音 / 中文 / 追加句 /
# 禁止句 / 闭嘴 / summary / 本集设定），五项沿用 [五项·类别]；旧格式每镜一条 ERROR，前缀 [旧格式]。改格式前先通知画布。
OFFICIAL_FIELDS = ("subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music")
BASE_FIELDS = ("integrated_multimodal_description", "overall_soundscape", "non_diegetic_music")
OFFICIAL_HEAD = re.compile(r"^(%s):" % "|".join(OFFICIAL_FIELDS + BASE_FIELDS[:1]), re.M)
ALIGN_I2VA = re.compile(r"^For the target video, at 0\.00 seconds into the target video, <Picture 1> \(from \[Shot 1\]\) is fully referenced\.")
ALIGN_FL2VA = re.compile(r"^How the reference pictures align with the target video — Picture 1 \(from Shot 1\) aligns with the 0\.00-second mark of the target video; Picture 2 \(from Shot (\d+)\) aligns with the (\d+\.\d\d)-second mark of the target video\.")
ALIGN_L2VA = re.compile(r"^How the reference pictures align with the target video — <Picture 1> \(from \[Shot (\d+)\]\) aligns with the (\d+\.\d\d)-second mark of the target video\.")


def official_kind(p):
    """'ref' = Ref2VA 六段式；'base' = 三栏式（T2VA / I2VA / FL2VA / L2VA）；None = 不是官方格式（旧格式）。"""
    heads = set(OFFICIAL_HEAD.findall(p or ""))
    if "integrated_multimodal_description" in heads:
        return "base"
    if len(heads) >= 2:
        return "ref"
    return None


def is_official(p):
    return official_kind(p) is not None


def shot_type(s, roles, scenes, off):
    """按队列字段判断镜头类型。有参考图（场景图 / 出镜角色图）→ Ref2VA；没有参考图时按首尾帧分 T2VA / I2VA / FL2VA / L2VA。"""
    first = bool(s.get("firstFrameAssetId") or s.get("firstFrameFrom"))
    last = bool(s.get("lastFrameAssetId") or s.get("lastFrameFrom"))
    if [x for x in scenes if is_id(x)] or [x for x in roles if is_id(x) and x not in off]:
        return "Ref2VA"
    return "FL2VA" if first and last else "I2VA" if first else "L2VA" if last else "T2VA"


def official_sections(p, fields):
    head = re.compile(r"^(%s):" % "|".join(fields), re.M)
    marks = [(m.group(1), m.start(), m.end()) for m in head.finditer(p)]
    secs = {}
    for k, (name, st, en) in enumerate(marks):
        nxt = marks[k + 1][1] if k + 1 < len(marks) else len(p)
        secs.setdefault(name, p[en:nxt].strip())
    return [m[0] for m in marks], secs


D_BLOCK = re.compile(r"<d>(.*?)</d>", re.S)
OFF_SPAN = re.compile(r"\[(\d+(\.\d+)?)\s*s?\s*[-–~]\s*(\d+(\.\d+)?)\s*s\]|(?<![\d.])\d+(\.\d+)?\s*[-–~～至到]\s*\d+(\.\d+)?\s*秒\s*[:：]|\b\d{1,2}:\d{2}\s*[-–]\s*\d{1,2}:\d{2}\b")
OFF_NEG = re.compile(r"\bno (background )?music\b|\bwithout (any )?(background )?music\b|\bno (speech|voices?|dialogue|talking)\b|\bnobody (speaks|talks)\b|\bdoes(n't| not) (speak|talk)\b", re.I)


def official_checks(rep, W, s, p, sec, dl, n_pics, typ, raw):
    kind = official_kind(p)
    fields = OFFICIAL_FIELDS if kind == "ref" else BASE_FIELDS
    body_key = "detailed_description" if kind == "ref" else "integrated_multimodal_description"
    tag = "六栏" if kind == "ref" else "三栏"
    # 格式和镜头类型对得上
    if typ == "Ref2VA" and kind == "base":
        rep.add("ERROR", W, "[官方·类型] 这一镜绑了场景图 / 角色图，是参考图出片（Ref2VA），要写六段式（subject_definitions … non_diegetic_music），不是三栏式")
    if typ != "Ref2VA" and kind == "ref":
        rep.add("ERROR", W, "[官方·类型] 这一镜没有场景图 / 角色图，是 %s，要写三栏式（%sintegrated_multimodal_description / overall_soundscape / non_diegetic_music），不是 Ref2VA 六段式（照官方指南，未实测）" % (typ, "" if typ == "T2VA" else "第一行对齐句 + "))
    if raw and re.search(r"\{\{\s*本集\.|｛｛\s*本集", raw):
        rep.add("ERROR", W, "[官方·本集设定] 官方格式不用 {{本集.…}} 占位，风格句、光线等每镜写完整的英文（正本 v2026-11-13.1）")
    order, secs = official_sections(p, fields)
    miss = [f for f in fields if f not in secs]
    if miss:
        rep.add("ERROR", W, "[官方·%s] 缺栏目：%s。依次是 %s，栏目名英文原样、行首、后面跟冒号" % (tag, "、".join(miss), " / ".join(fields)))
    seen = list(dict.fromkeys(f for f in order if f in fields))
    if not miss and [f for f in fields if f in seen] != seen:
        rep.add("ERROR", W, "[官方·%s] 栏目顺序不对，应依次是 %s" % (tag, " / ".join(fields)))
    for f in fields:
        if f in secs and not secs[f].strip():
            rep.add("ERROR", W, "[官方·%s] %s 是空的%s" % (tag, f, "；不要配乐写 N/A" if f == "non_diegetic_music" else ""))
    body = secs.get(body_key, "")
    # 三栏式的第一行对齐句（官方指南原句，I2VA / FL2VA / L2VA 才有）
    if kind == "base":
        first_line = p.lstrip().split("\n", 1)[0]
        pat = {"I2VA": ALIGN_I2VA, "FL2VA": ALIGN_FL2VA, "L2VA": ALIGN_L2VA}.get(typ)
        if typ == "T2VA" and not first_line.startswith("integrated_multimodal_description:"):
            rep.add("ERROR", W, "[官方·对齐句] T2VA 不写对齐句，第一行直接是 integrated_multimodal_description:")
        elif pat:
            m = pat.match(first_line)
            if not m:
                rep.add("ERROR", W, "[官方·对齐句] %s 第一行要照官方原句写对齐句（get 提示词 官方格式 里有三种原句），后面空一行再写 integrated_multimodal_description（照官方指南，未实测）" % typ)
            elif typ in ("FL2VA", "L2VA") and is_num(sec) and m.lastindex and abs(float(m.group(m.lastindex)) - float(sec)) > 0.5:
                rep.add("WARN", W, "[官方·对齐句] 对齐句里结尾帧在 %s 秒，镜头是 %s 秒；写成实际片长，两位小数" % (m.group(m.lastindex), sec))
    # 追加句、旧写法残留、dialogue
    if re.search(r"这段听到的|Heard in this segment|Audible audio is", p):
        rep.add("ERROR", W, "[官方·追加句] 正文里有画布禁背景乐追加句（这段听到的 / Audible audio is…）；官方格式原样提交，配乐写在 non_diegetic_music，不要这些句子")
    if re.search(r"^(参考说明|对白|画面要求|声音|主要动作)[（(：:]", p, re.M):
        rep.add("ERROR", W, "[官方·%s] 混进了旧写法的「参考说明 / 对白 / 画面要求 / 声音 / 主要动作」行；台词写进 <d>，其余并进对应栏目" % tag)
    if dl:
        rep.add("ERROR", W, "[官方·台词] 官方格式 dialogue 留空 []，台词只写在 %s 的 <d>[Chinese] …</d> 里" % body_key)
    # Subject（六段式）
    if kind == "ref":
        sd = secs.get("subject_definitions", "")
        defs = {}
        for line in sd.splitlines():
            m = re.match(r"\s*<Subject\s*(\d+)>", line)
            if m:
                defs[int(m.group(1))] = line
        if "subject_definitions" in secs and not defs:
            rep.add("ERROR", W, "[官方·Subject] subject_definitions 里没有 <Subject N> 定义；人物、场景各一行，写明来自哪张 <Picture N>")
        if defs and sorted(defs) != list(range(1, len(defs) + 1)):
            rep.add("ERROR", W, "[官方·Subject] Subject 编号要从 1 连续编：现在是 %s" % ",".join(map(str, sorted(defs))))
        for n, line in sorted(defs.items()):
            if not re.search(r"<Picture\s*\d+>", line):
                rep.add("WARN", W, "[官方·Subject] <Subject %d> 没写来自哪张 <Picture N>；参考图出片里每个 Subject 都写明出处" % n)
        undef = sorted(x for x in set(int(x) for x in re.findall(r"<Subject\s*(\d+)>", p)) if defs and x not in defs)
        if undef:
            rep.add("ERROR", W, "[官方·Subject] 正文用到 <Subject %s>，subject_definitions 里没有定义" % ",".join(map(str, undef)))
        pics_def = sorted(set(int(x) for x in re.findall(r"<Picture\s*(\d+)>", sd)))
        if n_pics and pics_def and pics_def[-1] <= n_pics and len(pics_def) < n_pics:
            rep.add("WARN", W, "[官方·Subject] 交了 %d 张参考图，subject_definitions 只用到 <Picture %s>；没用到的图会被模型随意用" % (n_pics, ",".join(map(str, pics_def))))
        sm = secs.get("summary", "")
        if sm and not re.match(r"\s*\[[a-z +]+\]", sm):
            rep.add("WARN", W, "[官方·summary] summary 开头写任务类型方括号，参考图出片写 [reference generation]")
    # 台词
    for k, f in secs.items():
        if k != body_key and "<d>" in f:
            rep.add("ERROR", W, "[官方·台词] %s 里写了 <d> 台词；台词只写在 %s" % (k, body_key))
    order_s = []
    for m in D_BLOCK.finditer(body):
        b = m.group(1)
        if not re.match(r"\[[A-Z][a-z]+\] \S", b):
            rep.add("ERROR", W, "[官方·台词] <d>%s</d> 格式不对；写成 <d>[Chinese] 原话。</d>（方括号语言名、空格、原话）" % b[:20])
        elif not re.search(r"[。！？.!?…」”～~]$|——$|—$", b.strip()):
            rep.add("WARN", W, "[官方·台词] <d>%s</d> 句末没有 。？！，最后一个音容易丢" % b[:20])
        before = body[max(0, m.start() - 300):m.start()]
        before = before[before.rfind("</d>") + 4:] if "</d>" in before else before
        sp = re.findall(r"\(S(\d+)(?:,\s*S\d+)*\)", before)
        if not sp:
            rep.add("ERROR", W, "[官方·台词] <d>%s</d> 前面没标说话人；写成 <Subject N>, <声音描述> (S1) asks: <d>…</d>" % b[:20])
        else:
            order_s.append(int(sp[-1]))
    firsts = list(dict.fromkeys(order_s))
    if firsts and firsts != list(range(1, len(firsts) + 1)):
        rep.add("WARN", W, "[官方·台词] 说话人编号要按第一次出声的先后从 S1 编：现在依次是 %s" % ",".join("S%d" % x for x in firsts))
    if not D_BLOCK.search(body) and re.search(r"[“\"「][^”\"」\n]*[一-鿿][^”\"」\n]*[”\"」]", body) and re.search(r"\b(says|asks|answers|replies|speaks)\b", body):
        rep.add("ERROR", W, "[官方·台词] 台词写在引号里、没有 <d>；写成 <d>[Chinese] 原话。</d>")
    for m in D_BLOCK.finditer(body):
        after = body[m.end():m.end() + 160]
        if not re.search(r"clos(es|e|ing) (his|her|their) (mouth|lips)|lips (are |stay )?closed", after, re.I):
            rep.add("WARN", W, "[官方·闭嘴] <d>%s</d> 后面没写闭嘴（He closes his mouth …）；19/19 干净的测试正文每句后都写了" % m.group(1)[:20]); break
    # 切镜
    shots_ = list(re.finditer(r"\[Shot\s*(\d+)\]([^\n\[]{0,40})", body))
    if body_key in secs and not shots_:
        rep.add("ERROR", W, "[官方·切镜] %s 里没有 [Shot 1]" % body_key)
    last_t = 0.0
    for k, m in enumerate(shots_):
        n = int(m.group(1))
        if n != k + 1:
            rep.add("ERROR", W, "[官方·切镜] 镜头编号要从 [Shot 1] 连续编，第 %d 个写成了 [Shot %d]" % (k + 1, n)); break
        tm = re.search(r"\bAt (\d{1,2}):(\d{2})(?:\.(\d{1,3}))?", m.group(2))
        if k == 0:
            if tm:
                rep.add("WARN", W, "[官方·切镜] [Shot 1] 不写时间，从第二个镜头起写 At 00:04.000")
            continue
        if not tm:
            rep.add("ERROR", W, "[官方·切镜] [Shot %d] 后面没写切点时刻；写成 [Shot %d] At 00:04.000, the shot cuts to …" % (n, n)); continue
        t = int(tm.group(1)) * 60 + int(tm.group(2)) + (int((tm.group(3) or "0").ljust(3, "0")) / 1000.0)
        if t <= last_t:
            rep.add("ERROR", W, "[官方·切镜] [Shot %d] 的切点 %s 不比上一个镜头晚" % (n, tm.group(0)[3:]))
        if is_num(sec) and t >= sec:
            rep.add("ERROR", W, "[官方·切镜] [Shot %d] 的切点 %s 超出镜头时长 %s 秒" % (n, tm.group(0)[3:], sec))
        last_t = t
    span = OFF_SPAN.search(body)
    if span:
        rep.add("ERROR", W, "[官方·切镜] %s 里用了时间段「%s」；官方格式不写时间段，动作按先后写，切镜只写 [Shot N] At 00:0X.000" % (body_key, span.group(0)))
    # 声音两栏
    ndm = secs.get("non_diegetic_music", "").strip()
    if ndm and ndm.upper().rstrip(".") != "N/A" and len(ndm) < 4:
        rep.add("ERROR", W, "[官方·声音] non_diegetic_music 写「%s」看不懂；不要配乐写 N/A，要配乐写乐器、速度、强弱变化" % ndm)
    if "<d>" in secs.get("overall_soundscape", ""):
        rep.add("ERROR", W, "[官方·声音] overall_soundscape 里写了台词；这一栏只写环境声和动作声")
    neg = OFF_NEG.search(p)
    if neg:
        rep.add("WARN", W, "[官方·禁止句] 写了「%s」；官方格式不写禁止句（会把那东西招来），不要配乐在 non_diegetic_music 写 N/A，没人说话的地方只写动作" % neg.group(0))
    # 送角色声音（v2026-11-13.2，第 17 节测试）：voiceRoleIds 和正文 <Audio N> 要对上
    vr = s.get("voiceRoleIds")
    auds = sorted(set(int(x) for x in re.findall(r"<Audio\s*(\d+)>", p)))
    if vr is not None:
        if not isinstance(vr, list) or not (1 <= len(vr) <= 3) or not all(is_id(x) for x in vr):
            rep.add("ERROR", W, "[官方·声音] voiceRoleIds 要写 1～3 个角色 ID（说话的角色，按 S1、S2 的顺序）；不送声音就整个不写"); vr = vr if isinstance(vr, list) else []
        else:
            notin = [x for x in vr if x not in (s.get("roleIds") or [])]
            if notin:
                rep.add("ERROR", W, "[官方·声音] voiceRoleIds 里有 %d 个不在这一镜 roleIds 里" % len(notin))
            if len(set(vr)) != len(vr):
                rep.add("ERROR", W, "[官方·声音] voiceRoleIds 里有重复的角色")
    if auds and not vr:
        rep.add("ERROR", W, "[官方·声音] 正文写了 <Audio %s>，但这一镜没写 voiceRoleIds，画布不会送声音；要送就在 voiceRoleIds 按 S1、S2 的顺序写说话的角色，不送就把 <Audio N> 都删掉" % ",".join(map(str, auds)))
    if vr and not auds:
        rep.add("ERROR", W, "[官方·声音] 写了 voiceRoleIds（%d 个），正文却没有 <Audio N>；照正本「送角色声音」的范例在 subject_definitions、summary、retention_analysis 和每句台词前写 <Audio N>，不送就删掉 voiceRoleIds" % len(vr))
    if vr and auds:
        if auds != list(range(1, len(auds) + 1)):
            rep.add("ERROR", W, "[官方·声音] <Audio N> 要从 1 连续编：现在是 %s" % ",".join(map(str, auds)))
        if len(auds) != len(vr):
            rep.add("ERROR", W, "[官方·声音] 正文有 %d 个 <Audio N>，voiceRoleIds 有 %d 个，要一一对上（<Audio 1> = voiceRoleIds 第 1 个 = S1）" % (len(auds), len(vr)))
    if auds:
        sd_ = secs.get("subject_definitions", "")
        for n in auds:
            m = re.search(r"<Audio\s*%d>\s+is the voice-timbre reference for <Subject\s*\d+>\s*\(S(\d+)\)" % n, sd_)
            if not m:
                rep.add("WARN", W, "[官方·声音] subject_definitions 里没有「<Audio %d> is the voice-timbre reference for <Subject N> (S%d).」这一行" % (n, n))
            elif int(m.group(1)) != n:
                rep.add("WARN", W, "[官方·声音] <Audio %d> 对的是 S%s；按正本，<Audio N> 和 voiceRoleIds 都按 S1、S2 的顺序排" % (n, m.group(1)))
        if kind == "ref" and "audio reference" not in secs.get("summary", ""):
            rep.add("WARN", W, "[官方·声音] 送声音时 summary 的任务类型写 [reference generation + audio reference]")
    # 中文：除 <d> 里的台词和引号里的画面文字，正文用英文
    rest = re.sub(r"[\"“「][^\"”」\n]*[\"”」]", "", D_BLOCK.sub("", p))
    cj = re.findall(r"[一-鿿]+", rest)
    if cj:
        rep.add("ERROR", W, "[官方·中文] 官方格式除 <d> 里的台词和引号里的画面文字外都用英文，现在有中文：%s" % "、".join(cj[:4]))


def official_five(rep, W, p):
    """五项写进正文开头的风格句和每个 [Shot]，英文关键词。"""
    kind = official_kind(p)
    _, secs = official_sections(p, OFFICIAL_FIELDS if kind == "ref" else BASE_FIELDS)
    t = secs.get("detailed_description", "") + "\n" + secs.get("integrated_multimodal_description", "") + "\n" + secs.get("subject_definitions", "")
    need = [
        ("风格胶片", r"film grain|Kodak|grain\b|35mm film|film stock", "开头风格句写胶片和颗粒（Kodak Vision3 250D film grain）"),
        ("光线", r"light|lit\b|lamp|sun|window|daylight|neon|candle", "写光源、方向、冷暖（window light from the left, warm downlights）"),
        ("景别焦段", r"(close-up|close up|medium|wide|full shot|long shot|extreme close)[\s\S]*?(\d+\s?mm|depth of field|focus|bokeh)|(\d+\s?mm|depth of field)[\s\S]*?(close-up|close up|medium|wide|full shot|long shot)", "每个 [Shot] 写景别（close-up / medium shot），整体写焦段或景深（35mm-equivalent lens, shallow depth of field）"),
        ("构图", r"(left|right|center|centre|middle|upper third|lower third)[\s\S]*?(foreground|background|midground|depth of field|blurred|behind)|(foreground|background|midground|depth of field)[\s\S]*?(left|right|center|centre|middle)", "写人在画面哪边（on the left of the frame）和层次（foreground / background 或 depth of field）"),
        ("运镜机位", r"(eye level|eye-level|low angle|high angle|overhead|top-down|three-quarter|side view|profile)[\s\S]*?(fixed|static|locked|push(es)? in|pull(s)? (out|back)|track|pan|tilt|dolly|handheld|follows)|(fixed|static|push(es)? in|track|pan|dolly|handheld)[\s\S]*?(eye level|low angle|high angle|three-quarter)", "写机位角度（eye level / low angle）和镜头怎么动（fixed camera / slowly pushes in）"),
    ]
    for code, pat, how in need:
        if not re.search(pat, t, re.I):
            rep.add("ERROR", W, "[五项·%s] 官方格式没写%s：%s" % (code, code, how))


# ---- 漫剧老李对照并入（正本 v2026-11-23.1，B1～B21 + 附录三条）----
# 来源：部分规则参考漫剧老李 manju-laoli-skill（MIT License，见 THIRD_PARTY_NOTICES.md）；每条的判断办法和报错格式见 h3q检查说明.md「漫剧老李对照并入」一节。
# 约定：这一块只在官方格式下跑；一律只报 WARN / HINT，不新增 ERROR；拿不准宁可不报；台词 <d> 里的原话不参与（台词语感、台词时长除外）；
# 按 [Shot N] 切块判断。新增前缀（画布按前缀分组，格式不要改）：[台词语感] [修辞] [虚假精度] [景别内容] [分镜五项] [参考图状态] [视线]
# [构图层次] [否定词] [背景人物] [反光道具] [接触路径] [假表演词] [文本残留] [道具状态] [并列主体] [特写占比] [接尾帧·景别]；
# 台词整镜时长沿用 [时长] 偏短：…；建议约 N 秒（格式不变）；人物定义了没用上沿用 [官方·Subject]。
SHOT_MARK = re.compile(r"\[Shot\s*(\d+)\]")
SENT_SPLIT = re.compile(r"(?<=[.!?])\s+|\n+")
OFF_LIGHT_WORD = re.compile(r"\b(?:light|lighting|lit|lamps?|sun|sunlight|moonlight|window|daylight|candle|candlelight|downlights?|lantern)\b|\d{4}\s?K\b", re.I)
PERSON_LINE = re.compile(r"\b(?:man|woman|boy|girl|years old|aged)\b|\bin (?:his|her) ", re.I)
SCENE_HEAD = re.compile(r"\b(?:room|office|corridor|hallway|street|courtyard|garden|interior|exterior|location|setting|environment|hall|lobby|building|house|bedroom|kitchen|alley|boardroom|scene)\b", re.I)


def off_parts(p):
    """官方格式拆开：(格式, 各栏目, 正文栏, subject_definitions)。正文栏：六栏式是 detailed_description，三栏式是 integrated_multimodal_description。"""
    kind = official_kind(p)
    _, secs = official_sections(p, OFFICIAL_FIELDS if kind == "ref" else BASE_FIELDS)
    body = secs.get("detailed_description" if kind == "ref" else "integrated_multimodal_description", "")
    return kind, secs, body, (secs.get("subject_definitions", "") if kind == "ref" else "")


def shot_blocks(body):
    """按 [Shot N] 切块：(开头风格段, [(镜号, 这一镜的文字)])。没有 [Shot] 时块列表是空的。"""
    ms = list(SHOT_MARK.finditer(body))
    if not ms:
        return body, []
    blocks = []
    for k, m in enumerate(ms):
        end = ms[k + 1].start() if k + 1 < len(ms) else len(body)
        blocks.append((int(m.group(1)), body[m.end():end]))
    return body[:ms[0].start()], blocks


def no_d(t):
    """去掉 <d>…</d> 台词原话。"""
    return D_BLOCK.sub(" ", t or "")


def sentences(t):
    return [x.strip() for x in SENT_SPLIT.split(t or "") if x and x.strip()]


def snip(t, m, w=28):
    return re.sub(r"\s+", " ", t[max(0, m.start() - w):m.end() + w]).strip()


def off_person_lines(sd):
    """subject_definitions 里的人物行 {编号: 整行}。逗号前面有 room / office / street 这类词的是场景行，不算人物。"""
    res = {}
    for line in (sd or "").splitlines():
        m = re.match(r"\s*<Subject\s*(\d+)>", line)
        if not m:
            continue
        head = re.split(r"[,，]", line, 1)[0]
        if SCENE_HEAD.search(head):
            continue
        # 收窄（v2026-11-23.2）：只看定义句开头 60 个字符；人物词后面跟所有格 's 的是物件（the lotus girl's small boat），不算人
        lead = line[m.end():m.end() + 60]
        if any(not re.match(r"\s*['’]s\b", lead[pm.end():]) for pm in PERSON_LINE.finditer(lead)):
            res[int(m.group(1))] = line
    return res


def dialogue_text(raw):
    """<d>[Chinese] 原话。</d> 里的原话。"""
    mm = re.match(r"\s*\[[A-Za-z]+\]\s*(.*)$", raw, re.S)
    return (mm.group(1) if mm else raw).strip()


# B1 台词语感（老李 C28）：只报不改，已批准的台词先问用户
LY_WRITTEN = re.compile(r"是否|因此|从而|鉴于|予以|加以|可否|何以|颇为|甚为|以及|然而|由于|进行")
LY_PARTICLE = re.compile(r"[啊呢吧吗呀哦嘛啦哈]")
LY_PUNCT = re.compile(r"[，、；,;…—]")
LY_CALL = re.compile(r"^(?:老|小)[一-鿿]{1,2}[，,]|^[一-鿿]{1,3}(?:总|哥|姐|叔|姨|爷|师傅|老师|经理|主任|医生|先生|女士|同学|局长|董事长)[，,]")


def official_dialogue_style_checks(rep, W, body, sd):
    names = set(re.findall(r"[一-鿿]{2,4}", sd or ""))  # 官方格式 Subject 行是英文，这里只会取到引号里写的中文名
    tip = "台词已批准的先问用户，不要自己改"
    for m in D_BLOCK.finditer(body):
        t = dialogue_text(m.group(1))
        if not re.search(r"[一-鿿]", t):
            continue
        shown = "<d>%s%s</d>" % (t[:14], "…" if len(t) > 14 else "")
        why = []
        w = sorted(set(LY_WRITTEN.findall(t)))
        if w:
            why.append("书面腔用词%s" % "".join("「%s」" % x for x in w))
        for sent in re.split(r"[。！？!?]", t):
            n = len(re.findall(r"[一-鿿]", sent))
            if n >= 20 and not LY_PUNCT.search(sent):
                why.append("有一句 %d 字中间没有停顿" % n)
                break
        nz = len(re.findall(r"[一-鿿]", t))
        if nz >= 40 and not LY_PARTICLE.search(t):
            why.append("%d 字里一个语气词都没有（啊呢吧吗呀哦嘛啦哈）" % nz)
        if why:
            rep.add("WARN", W, "[台词语感] %s %s，听着像书面语；口语、短句、一次一个信息；%s" % (shown, "；".join(why), tip))
        if LY_CALL.match(t) or any(t.startswith(x + "，") or t.startswith(x + ",") for x in names):
            rep.add("HINT", W, "[台词语感] %s 以喊名字/称呼开头，听着像旁白点名；%s" % (shown, tip))


# B2 官方格式整镜台词时长（老李 gate_check 闸门2，改用我们的语速）：字数÷语速 + 标点停顿 + 末尾 1 秒；> seconds 报 [时长] 偏短
DT_SLOW = re.compile(r"\b(?:whispers?|whispering|under (?:his|her|their) breath|word by word|murmurs?|mutters?)\b", re.I)
DT_FAST = re.compile(r"\b(?:shouts?|shouting|rapidly|talking over|yells?|yelling)\b", re.I)


def official_dialogue_time_checks(rep, W, body, sec):
    if not is_num(sec) or not (5 <= sec <= 15):
        return
    chars, speak, pause, prev = 0, 0.0, 0.0, 0
    for m in D_BLOCK.finditer(body):
        lead = body[prev:m.start()][-160:]  # 这句 <d> 前面的说话方式（whispers / shouts…）
        prev = m.end()
        t = dialogue_text(m.group(1))
        n = len(re.findall(r"[一-鿿]", t))
        if not n:
            continue
        den = 5.0 if DT_FAST.search(lead) else 3.0 if DT_SLOW.search(lead) else 3.5
        chars += n
        speak += n / den
        t2 = re.sub(r"…+|\.{3,}", "", t)
        pause += 0.5 * len(re.findall(r"…+|\.{3,}", t)) + 0.2 * len(re.findall(r"[，、,]", t2)) + 0.4 * len(re.findall(r"[。？！?!]", t2))
    if not chars:
        return
    total = speak + pause + 1.0  # 末尾留 1 秒
    if total <= sec:
        return
    need = int(total) + (1 if total > int(total) else 0)
    n = max(5, min(15, need), int(min(15, sec + 1)))
    tail = "，15 秒也放不下，要拆镜" if total > 15 else ""
    rep.add("WARN", W, "[时长] 偏短：%d 字台词（字数÷语速 %.1f 秒 + 标点停顿 %.1f 秒 + 末尾留白 1 秒）整镜估计至少要约 %.1f 秒，只写了 %g 秒%s；建议约 %d 秒" % (chars, speak, pause, total, sec, tail, n))


# B3 比喻、修辞、虚假精度（老李 C20c / C20m）
FIG_RE = re.compile(r"\blike (?:a|an|the)\b|\bas if\b|\bas though\b|\bresembl\w+|\bshaped like\b|\bpresses? like\b|\bnailed (?:to|onto) the (?:floor|ground)\b", re.I)
SPUR_RE = re.compile(r"\d+(?:\.\d+)?\s?%|\d+(?:\.\d+)?\s?mm of (?:pupil|shake|movement)|\bfocal plane (?:locked|fixed)\b|\bmicro-?breath\w*", re.I)


def shot_only_text(body):
    """只取 [Shot N] 块里的正文（拼起来）；第一个 [Shot] 之前的开头风格段是统一模板、故意写的，不扫。没有 [Shot] 标记时返回空串（宁可漏报）。"""
    _, blocks = shot_blocks(body)
    return "\n".join(t for _, t in blocks)


def official_figurative_checks(rep, W, body):
    t = no_d(shot_only_text(body))
    hits = [snip(t, m) for m in FIG_RE.finditer(t)]
    if hits:
        rep.add("HINT", W, "[修辞] 正文里有比喻句式：%s；模型会把比喻里的名词当真物件画出来（端坐如钟 → 殿顶挂下一口大钟）。人物姿态、动作、光、影、情绪不用比喻；雾、水、金属这类材质/形态的比喻可以保留，确认它就是想画成的样子" % "；".join("「%s」" % x for x in hits[:3]))
    sp = []
    for m in SPUR_RE.finditer(t):
        if m.group(0) not in sp:
            sp.append(m.group(0))
    if sp:
        rep.add("HINT", W, "[虚假精度] 写了「%s」这类摄影机说明书式的数字/术语，模型读不出来；去掉，改写成看得见的画面" % "」「".join(sp[:3]))


# B4 景别只写它装得下的东西（老李 C18f / C25d / C20k）+ B5 五项按 [Shot] 分块（老李 C18g / C33 / C32）
CU_RE = re.compile(r"(?<![\w-])(?<!medium )(?:extreme )?close[- ]?up", re.I)
CU_BODY = re.compile(r"\b(?:chest|waist|hips?|legs?|knees?|feet|shoes|full[- ]body|whole body|walking|walks?|kneels?|kneeling|steps? (?:forward|back|toward|towards|away|closer|aside)|runs? (?:forward|away|toward|towards|across|down|off|out|past))\b", re.I)
CU_FORCE = re.compile(r"\b(?:twists?|drives?|pushes? off|rotates?|tenses?|braces?)\b[^.]{0,25}?\b(?:waist|hips?|legs?|knees?|feet)\b", re.I)
SCALE_CHANGE = re.compile(r"\bpull(?:s|ing)? (?:back|out|away)\b|\bzoom(?:s|ing)? out\b|\bwiden\w*|\breveal\w*|\bdolly(?:ies|ing)? (?:out|back)\b|\btracks? back\b|\bcranes?\b", re.I)
MCU_RE = re.compile(r"\b(?:medium close[- ]?up|bust shot)\b", re.I)
FULL_RE = re.compile(r"\b(?:full[- ]body|full height|both of them standing)\b", re.I)
PART_RE = re.compile(r"close[- ]?up (?:of|on) (?:(?:his|her|their|the|a) |<Subject\s*\d+>'s )?(?:hands?|fingers?|sword|sheath|ring|document|phone)\b|\binsert (?:shot|frame)\b|\bmacro\b", re.I)
SHUT_RE = re.compile(r"\bclos\w+ (?:his|her|their) (?:mouth|lips)\b|\b(?:mouth|lips) (?:are |is |stay |stays |remain |remains )?closed\b|\blips closed\b", re.I)
BIG_ACT = re.compile(r"\b(?:slams?|leaps?|bursts? into laughter|wide-eyed stare)\b", re.I)
GLOBAL_MARK = re.compile(r"\b(?:every|each|all) shots?\b|\bthroughout\b|\bacross all\b", re.I)
SZ_ALT = r"extreme close[- ]?up|medium close[- ]?up|close[- ]?up|extreme (?:wide|long) shot|medium (?:wide|long)(?: shot)?|medium shot|wide shot|long shot|establishing shot|full shot|cowboy shot|bust shot"
SZ_RE = re.compile(SZ_ALT, re.I)


def size_level(phrase):
    """景别阶梯：0 极远 / 1 全景 / 2 中全景 / 3 中景 / 4 中近景 / 5 特写 / 6 大特写。"""
    s = phrase.lower().replace("-", " ")
    if s.startswith("extreme close"):
        return 6
    if s.startswith("medium close") or s.startswith("bust"):
        return 4
    if s.startswith("close"):
        return 5
    if s.startswith("extreme"):
        return 0
    if s.startswith("medium wide") or s.startswith("medium long") or s.startswith("cowboy"):
        return 2
    if s.startswith("medium"):
        return 3
    return 1


def official_framing_checks(rep, W, intro, blocks):
    for n, t in blocks:
        tag = "[Shot %d]" % n
        d = no_d(t)
        cu = CU_RE.search(d)
        if cu and not SCALE_CHANGE.search(d):
            body_hits = []
            for m in CU_BODY.finditer(CU_FORCE.sub(" ", d)):
                if m.group(0).lower() not in body_hits:
                    body_hits.append(m.group(0).lower())
            if body_hits:
                rep.add("WARN", W, "[景别内容] %s 是特写，却写了「%s」；特写装不下身体和走动，模型会把脸裁掉或把人缩小。改成近景/中景，或只写脸和手看得见的动作" % (tag, "、".join(body_hits[:4])))
            if BIG_ACT.search(d):
                rep.add("HINT", W, "[景别内容] %s 是特写，却写了「%s」这类大幅动作/夸张表情；特写里情绪越强动作越克制" % (tag, BIG_ACT.search(d).group(0)))
        if MCU_RE.search(d) and FULL_RE.search(d):
            rep.add("WARN", W, "[景别内容] %s 是中近景，却写了「%s」；中近景装不下全身，改成中景/全景或去掉" % (tag, FULL_RE.search(d).group(0)))
        if "<d>" in t and PART_RE.search(d):
            d2 = SHUT_RE.sub(" ", d)  # 台词后的「closes his mouth」不算拍到嘴
            if not re.search(r"\b(?:face|mouth|lips)\b", d2, re.I):
                rep.add("WARN", W, "[景别内容] %s 镜头收在手/道具局部（%s），嘴不在画内，却排了台词；模型会硬把脸塞进来。改成能看见说话人脸的景别，或台词挪到别的镜头" % (tag, PART_RE.search(d).group(0)))
    # B5：每个 [Shot] 自己写景别、机位角度、运镜（只在有 2 个以上 [Shot] 时查）；整段都没写的交给 [五项·…] ERROR
    if len(blocks) >= 2:
        gi = no_d(intro)
        for label, rx in (("景别", SIZE_EN), ("运镜", MOVE), ("机位角度", ANGLE)):
            have = []
            for k, (n, t) in enumerate(blocks):
                d = no_d(t)
                have.append(bool(rx.search((gi + " " + d) if k == 0 else d)))
            if not any(have) or (rx.search(gi) and GLOBAL_MARK.search(gi)):
                continue  # 开头写了「每个镜头都…」的全局句，算都写了
            miss = [blocks[k][0] for k, x in enumerate(have) if not x]
            if miss:
                rep.add("WARN", W, "[分镜五项] %s 没写%s；官方格式每个 [Shot] 都写景别、机位角度、运镜，切镜后模型不会沿用上一镜" % ("、".join("[Shot %d]" % x for x in miss), label))
    # 景别—焦段一致（只提示）
    for n, t in blocks:
        d = no_d(t)
        m = SZ_RE.search(d)
        mm = [int(x) for x in re.findall(r"(\d{2,3})\s?mm(?!\s*film)", d)]
        if not m or not mm:
            continue
        lv = size_level(m.group(0))
        if lv >= 5 and all(x <= 35 for x in mm):
            rep.add("HINT", W, "[分镜五项] [Shot %d] 特写配了 %s；特写一般 85mm 起，广角会变形（H3 不保证光学行为，只提示）" % (n, "、".join("%dmm" % x for x in mm)))
        elif lv <= 1 and all(x >= 85 for x in mm):
            rep.add("HINT", W, "[分镜五项] [Shot %d] 全景/远景配了 %s；全景一般 24–35mm，长焦会压缩空间（只提示）" % (n, "、".join("%dmm" % x for x in mm)))


# B6 参考图锁定项的「状态偏离」替换声明（老李 C29 / model-adapters 5.0.6）
_WEAR = r"(?:helmets?|hats?|caps?|glasses|coats?|jackets?|scarf|scarves|masks?|gloves?|necklaces?|rings?|watch(?:es)?|bags?)"
OVR_RE = re.compile(r"\b(?:(?:takes?|taking|pulls?|slips?) off|removes?|unbuttons?|sets? down|puts? down|takes? out)\b[^.]{0,40}?\b%s\b|\b(?:takes?|pulls?|slips?)\s+(?:his|her|their|the|a)\s+%s\s+off\b" % (_WEAR, _WEAR), re.I)
OVR_DECL = re.compile(r"\boverrid\w*|\binstead of\b|\bno longer (?:wearing|holding|carrying)\b|\bbare\b|\bnot (?:wearing|holding)\b|\bwithout the\b", re.I)


def official_override_checks(rep, W, kind, p, blocks, sd):
    if kind != "ref" or "<Picture" not in sd or OVR_DECL.search(p):
        return
    for n, t in blocks:
        m = OVR_RE.search(no_d(t))
        if m:
            rep.add("WARN", W, "[参考图状态] [Shot %d] 写了「%s」，可能和角色参考图叠加（参考图里戴着/穿着的东西，模型会再画一份，而不是换掉）；在该角色的 subject_definitions 行和这一镜写明偏离并以本镜为准，如 In this shot <Subject N> is not wearing the helmet shown in <Picture N>; this description overrides the reference picture；再写取下后本体的样子" % (n, re.sub(r"\s+", " ", m.group(0))[:40]))
            break


# B7 单人镜视线不点名画外角色、一镜一个视线落点（老李 C20f / C20g）。和我们「eyes fixed on <Subject N>」的写法有冲突，只做 HINT / 一镜多视线 WARN
GAZE_RE = re.compile(r"(?:\blooks?|\blooking|\bglances?|\bstares?) at <Subject\s*(\d+)>|\beyes (?:fixed |locked )?on <Subject\s*(\d+)>|\bgaze (?:toward|towards|on|at) <Subject\s*(\d+)>", re.I)
SINGLE_RE = re.compile(r"\bclose[- ]?up\b|\bsingle\b", re.I)
TWO_SHOT_RE = re.compile(r"over[- ]the[- ]shoulder|\btwo[- ]shot\b|\bboth\b|\ball three\b", re.I)
SEQ_THEN = re.compile(r"\b(?:and )?then\s+(?:looks?|glances?|turns? (?:his |her |their )?(?:head|gaze|eyes|face)|turns? to (?:look|face))\b", re.I)
SCAN_RE = re.compile(r"\bscans\b|\bsweeps? (?:his|her|their) (?:gaze|eyes) across\b", re.I)


def official_gaze_checks(rep, W, blocks, persons):
    for n, t in blocks:
        d = no_d(t)
        subs = set(int(x) for x in re.findall(r"<Subject\s*(\d+)>", d))
        if SINGLE_RE.search(d) and not TWO_SHOT_RE.search(d) and len(subs & set(persons)) >= 2:
            for m in GAZE_RE.finditer(d):
                tgt = int([g for g in m.groups() if g][0])
                if tgt in persons:
                    rep.add("HINT", W, "[视线] [Shot %d] 单人景别里写了视线落在 <Subject %d> 上；对方在画内吗？不在画内，点名会把对方塞进画框甚至克隆一个。🧪 待小样验证（同一镜对照 eyes fixed on <Subject N> 和 eyes toward the right edge of the frame），现有写法先不改" % (n, tgt))
                    break
        if len(SEQ_THEN.findall(d)) >= 2 or SCAN_RE.search(d):
            rep.add("WARN", W, "[视线] [Shot %d] 一个镜头里写了多次转视线（then looks / glances / scans…）；一镜一个视线落点，要换视线就开新的 [Shot]" % n)


# B8 过肩镜头的前景几何 + 多人镜「清晰主体 + 虚焦陪衬」（老李 C20e / C35）
OTS_RE = re.compile(r"over[- ]the[- ]shoulder|\bover <Subject\s*\d+>'s (?:left|right) shoulder", re.I)
OTS_SIDE = re.compile(r"\bover (?:the )?<Subject\s*(\d+)>'s (left|right) shoulder", re.I)
LAYER_WORD = re.compile(r"\b(?:foreground|background|blurred|out of focus|behind|midground)\b", re.I)


def official_overshoulder_checks(rep, W, blocks, persons):
    for n, t in blocks:
        d = no_d(t)
        if OTS_RE.search(d):
            if not re.search(r"\bforeground\b", d, re.I):
                rep.add("HINT", W, "[构图层次] [Shot %d] 过肩镜头没写 foreground；写明前景是谁、在画面左还是右，前景虚焦的人只写肩背不写动作（越过 A 右肩 → A 在画面左前景）" % n)
            for m in OTS_SIDE.finditer(d):
                num, side = m.group(1), m.group(2).lower()
                for sent in sentences(d):
                    if re.search(r"\bforeground\b", sent, re.I) and re.search(r"<Subject\s*%s>" % num, sent):
                        s2 = re.sub(r"\b(?:left|right) shoulder\b", " ", sent, flags=re.I)
                        sides = set(x.lower() for x in re.findall(r"\b(left|right)\b", s2, re.I))
                        if sides == {side}:
                            rep.add("WARN", W, "[构图层次] [Shot %d] 写的是越过 <Subject %s> 的%s肩，却把 <Subject %s> 放在画面%s前景，左右写反了（越过右肩 → 在画面左前景，越过左肩 → 在画面右前景）" % (n, num, side, num, side))
                            break
        elif len(set(int(x) for x in re.findall(r"<Subject\s*(\d+)>", d)) & set(persons)) >= 2 and not LAYER_WORD.search(d):
            rep.add("HINT", W, "[构图层次] [Shot %d] 有两个以上人物却没标层次（foreground / background / blurred）；过肩或前后景构图要写「清晰主体 + 虚焦陪衬」，陪衬只写虚焦的肩背；双人同清晰的中景可以不管" % n)


# B9 通用否定词扫描（老李 C19a / C24c）+ 附录第 3 条：no logos 在官方格式下也查
NEG_RE = re.compile(r"\b(?:no|not|never|without|doesn't|does not|don't|avoid|free of|absence of)\s+\w+", re.I)
NEG_OK = re.compile(r"not only\b|no longer\b|never appears? in (?:the )?frame|no cuts?\b|without (?:any )?cuts?\b", re.I)
LOGO_NEG = re.compile(r"\bno (?:logos?|signs?|lettering|readable characters|written characters)\b|\bno logos or lettering\b", re.I)


def official_negation_checks(rep, W, body):
    t = no_d(shot_only_text(body))
    if LOGO_NEG.search(t):
        rep.add("WARN", W, "[否定词] 写了 no logos / no signs / no lettering 类排除，会抹掉参考图里的 logo、招牌；改写 Any logos, signs and brand marks that appear in the reference pictures stay exactly as they are")
        t = LOGO_NEG.sub(" ", t)
    t = OFF_NEG.sub(" ", t)  # no music / no speech 已由 [官方·禁止句] 报过，不重复
    hits = []
    for m in NEG_RE.finditer(t):
        if NEG_OK.match(t[m.start():m.start() + 40]):
            continue
        hits.append(snip(t, m, 18))
    if hits:
        rep.add("WARN", W, "[否定词] 正文里有 %d 处否定/排除写法：%s；视频模型对词根敏感，被否定的东西反而会被画出来，改成正面写它是什么样（先观察误报，白名单以后补）" % (len(hits), "；".join("「%s」" % x for x in hits[:3])))


# B10 定义了的人物，正文里要出现（老李 C17）
def official_unused_person_checks(rep, W, body, persons):
    for n in sorted(persons):
        if re.search(r"<Picture\s*\d+>", persons[n]) and not re.search(r"<Subject\s*%d>" % n, body):
            rep.add("WARN", W, "[官方·Subject] <Subject %d> 定义了、也绑了参考图，detailed_description 里却一次都没出现；模型会随机安排他出场或消失，参考图也可能被乱用。写他入画/离画，或从 roleIds 去掉" % n)


# B11 背景人物点名分配动作；公共场景不写「无其他人物」（老李 C37 / C40）
GROUP_RE = re.compile(r"\b(?:two|three|four|several|a few|some|the)\s+(?:students|men|women|boys|girls|villagers|guests|onlookers|people|colleagues)\b", re.I)
GROUP_ACT = re.compile(r"\b(?:raise|wave|cheer|nod|clap|laugh|point|whisper|turn)\w*", re.I)
GROUP_OK = re.compile(r"\bonly\b|\bthe others?\b|\bthe rest\b|\bwhile the others?\b|\bone of\b|\bthe remaining\b", re.I)
PUBLIC_RE = re.compile(r"\b(?:classroom|canteen|street|market|lobby|open-plan|bar|station|square)\b", re.I)
EMPTY_RE = re.compile(r"\bno other (?:people|persons|figures)\b|\bnobody else\b|\bno one else\b|\bonly (?:these|the) (?:two|three)\b|\b(?:completely |totally )?empty (?:room|street|classroom|canteen|lobby|market|square|station|bar|hall|space|office)\b|\bdeserted\b", re.I)


def official_crowd_checks(rep, W, body, sd):
    t = no_d(body)
    for sent in sentences(t):
        m = GROUP_RE.search(sent)
        if m and GROUP_ACT.search(sent[m.end():m.end() + 40]) and not GROUP_OK.search(sent):
            rep.add("HINT", W, "[背景人物] 群体「%s」加了动作却没说是谁动、其余怎样；点名到人头（one of them raises a hand while the other two sit still）" % re.sub(r"\s+", " ", m.group(0)))
            break
    if PUBLIC_RE.search((sd or "") + " " + t) and EMPTY_RE.search(t):
        rep.add("HINT", W, "[背景人物] 公共场景（教室/街/大厅…）里写了「%s」，会把背景清空；改写人数 + 各人在做什么，或远景写人流密度" % EMPTY_RE.search(t).group(0))


# B13 反光道具不写光效 / B14 连续接触路径 / B15 假表演词 / B20 道具与物证 / B21 并列主体句式（都是 HINT）
SHINY_RE = re.compile(r"\b(?:jade|pendants?|bracelets?|bangles?|rings?|necklaces?|gems?|jewel\w*|brooch(?:es)?|mirrors?|lockets?)\b", re.I)
GLOWW_RE = re.compile(r"\b(?:lit by|catch\w* the light|reflect\w*|glint\w*|gleam\w*|glow\w*|shin(?:e|es|ing)|flame\w*|candlelight|lamplight)\b", re.I)
CONTACT_RE = re.compile(r"\b(?:slides?|runs?|traces?|glides?|drags?|strokes?|sweeps?|trails?)\s+(?:his|her|a|the)\s+(?:hand|fingers?|fingertips?|palm)\s+(?:from|along|across|over)\b", re.I)
OVERACT_RE = re.compile(r"\bsuddenly (?:widens?|stares?)\b|\bwide-eyed stare\b|\bmechanical(?:ly)? smil\w*|\brobotic\w*|\bbursts? into tears\b|\bsobs? (?:loudly|uncontrollably)\b|\bscreams?\b|\byells?\b|\bshouts? at the top\b|\beyes darting\b|\bnods? (?:vigorously|repeatedly)\b|\bshakes? (?:his|her|their) head (?:repeatedly|rapidly)\b", re.I)
OPENABLE_RE = re.compile(r"\b(?:umbrellas?|parasols?|fans?|lids?|box(?:es)?|books?|folding)\b", re.I)
OPEN_STATE_RE = re.compile(r"\b(?:open|opened|opens|opening|closed|closes|folded|furled|shut)\b", re.I)
THROUGH_RE = re.compile(r"\b(?:hands?|passes|pass|slides?|pushes|push|reaches|reach)\b[^.]{0,30}\b(?:through|out of)\b[^.]{0,15}\b(?:window|gap|slot|crack)\b", re.I)
ERA_I = re.compile(r"\b(?:ancient|imperial|hanfu|wuxia|xianxia)\b", re.I)
ERA_CS = re.compile(r"\b(?:Tang|Song|Ming)\s+(?:dynasty|era|period|style)\b")
MODERN_I = re.compile(r"\b(?:smartphones?|phones?|cars?|headlights?|power lines?|utility poles?|jeans|sneakers|plastic|zippers?)\b", re.I)
MODERN_CS = re.compile(r"\bLEDs?\b")
JUXT1 = re.compile(r"\b(?:hands?|fingers|eyes|lips)\s+and\s+(?:her|his|the)\s+(?:face|head)\s+(?:in|together|side by side)\b", re.I)
JUXT2 = re.compile(r"\b(?:face|head)\s+and\s+(?:her|his|the)\s+hands?\s+(?:in|together)\b", re.I)
DEIC_RE = re.compile(r"(?:^|[.!?]\s+|\]\s*)(?:this|that|these|those)\s+(?:hand|face|man|woman)\b", re.I)


def official_text_hint_checks(rep, W, body, p):
    t = no_d(body)
    for sent in sentences(t):  # B13
        if SHINY_RE.search(sent) and GLOWW_RE.search(sent):
            rep.add("HINT", W, "[反光道具] 同一句里反光小物件（%s）和光效词（%s）写在一起：「%s」；玉佩、首饰、镜面这类道具一旦和光/火同句，模型会把它画成自发光。只写材质本色，光写在别的句子里。🧪 待小样验证（刀刃、水面的高光不受影响）" % (SHINY_RE.search(sent).group(0), GLOWW_RE.search(sent).group(0), sent[:60]))
            break
    for sent in sentences(t):  # B14
        m = CONTACT_RE.search(sent)
        if m and re.search(r"\b(?:to|until|toward|towards)\b", sent[m.end():]):
            rep.add("HINT", W, "[接触路径] 「%s」是一条连续的接触路径，模型只看终态，会变成手在起点、下一秒已在终点；拆成几个落点（[Shot] 或分句），每个落点写手在哪、另一个人怎么反应" % sent[:70])
            break
    ov = []  # B15
    for m in OVERACT_RE.finditer(t):
        if m.group(0).lower() not in ov:
            ov.append(m.group(0).lower())
    if ov:
        rep.add("HINT", W, "[假表演词] 写了「%s」，是模型最爱过满的默认表演；确认剧本是否明写，没有就改成克制的肌肉动作（情绪越强，外部动作越克制）" % "」「".join(ov[:4]))
    op = []  # B20
    for m in OPENABLE_RE.finditer(t):
        if not OPEN_STATE_RE.search(t[max(0, m.start() - 50):m.end() + 50]) and m.group(0).lower() not in op:
            op.append(m.group(0).lower())
    if op:
        rep.add("HINT", W, "[道具状态] 可开合的东西（%s）没写开合状态；伞写已撑开/收拢捆紧，书写合着/翻开，扇写合着/展开" % "、".join(op[:4]))
    th = THROUGH_RE.search(t)
    if th:
        rep.add("HINT", W, "[道具状态] 「%s」是跨窗/缝递东西，容易穿模；改成东西已经在对方手里" % re.sub(r"\s+", " ", th.group(0))[:60])
    if (ERA_I.search(p) or ERA_CS.search(p)) and (MODERN_I.search(t) or MODERN_CS.search(t)):
        mo = MODERN_I.search(t) or MODERN_CS.search(t)
        rep.add("HINT", W, "[道具状态] 设定是古代/仙侠（%s），正文却出现现代物件「%s」；确认是不是年代没传下去" % ((ERA_I.search(p) or ERA_CS.search(p)).group(0), mo.group(0)))
    ju = JUXT1.search(t) or JUXT2.search(t)  # B21
    if ju:
        rep.add("HINT", W, "[并列主体] 「%s」是部位和脸并列同框的写法，会多出一张脸；一个镜头一个主体，部位写成 <Subject N>'s hand" % re.sub(r"\s+", " ", ju.group(0)))
    de = DEIC_RE.search(t)
    if de:
        rep.add("HINT", W, "[并列主体] 句首的「%s」没有归属，模型会自己补一个主体；写成 <Subject N>'s hand / face" % re.sub(r"[\s.!?\]]+", " ", de.group(0)).strip())


# B17 文本残留：占位语、AI 话术、工程/剪辑术语、栏目前后多出来的话（老李 C12 / 闸门4 / engineering-language）。中文占位语（同上、待定…）在官方格式里已被 [官方·中文] ERROR 兜住，这里只查英文
RS_ENG_I = re.compile(r"\bTBD\b|\bTODO\b|to be (?:added|decided)|\bplaceholder\b|\bas before\b|same as (?:the )?(?:previous|last) (?:shot|one)|\blet me know\b|\bhope this helps\b", re.I)
RS_ENG_CS = re.compile(r"\bHere is\b|\bHere's\b|\bSure,|\bCertainly\b|\bOf course\b")
RS_EDIT = re.compile(r"\bJ-?cut\b|\bL-?cut\b|\bmatch cut\b|\bsound bridge\b|\b180.degree (?:rule|line)\b|\baxis line\b|\bST\d{3}\b|\bCL\d{3}\b|\bMAP\d{3}\b", re.I)
RS_OK = re.compile(r"opening frame|same outfit", re.I)


def official_residue_checks(rep, W, kind, p, secs):
    first = next((ln.strip() for ln in p.splitlines() if ln.strip()), "")
    heads = ("subject_definitions:",) if kind == "ref" else ("integrated_multimodal_description:", "For the target video", "How the reference pictures align")
    if first and not first.startswith(heads):
        rep.add("WARN", W, "[文本残留] 第一行不是栏目名（「%s…」），栏目前多了一段话（开场白、说明）会被当成提示词的一部分；删掉，第一行直接写 %s" % (first[:24], heads[0]))
    parts = [x.strip() for x in re.split(r"\n\s*\n", secs.get("non_diegetic_music", "").strip()) if x.strip()]
    if len(parts) >= 2 and any(len(x) >= 40 for x in parts[1:]):
        rep.add("WARN", W, "[文本残留] non_diegetic_music 后面还有一大段文字（「%s…」）；最后一栏之后不要再写说明、问候" % parts[1][:24])
    scan = D_BLOCK.sub(" ", p)
    hits = []
    for rx in (RS_ENG_I, RS_ENG_CS):
        for m in rx.finditer(scan):
            if RS_OK.search(scan[max(0, m.start() - 40):m.end() + 40]):
                continue
            if m.group(0) not in hits:
                hits.append(m.group(0))
    if hits:
        rep.add("WARN", W, "[文本残留] 正文里有占位语或对话残留「%s」；每镜写完整，不写同上一镜、待补，不带 AI 的开场白" % "」「".join(hits[:4]))
    ed = []
    for m in RS_EDIT.finditer(scan):
        if m.group(0) not in ed:
            ed.append(m.group(0))
    if ed:
        rep.add("WARN", W, "[文本残留] 正文里有工程/剪辑术语「%s」；模型不认这些词，改成画面描述（谁在哪、镜头怎么动）" % "」「".join(ed[:4]))


def official_extra_checks(rep, W, s, p, sec):
    """官方格式下的漫剧老李对照并入检查（B1～B15、B17、B20、B21）。任何一个检查自己出错，只记一条 HINT，不拖垮整个 check。"""
    kind, secs, body, sd = off_parts(p)
    intro, blocks = shot_blocks(body)
    persons = off_person_lines(sd)
    for fn, args in (
        (official_dialogue_style_checks, (rep, W, body, sd)),
        (official_dialogue_time_checks, (rep, W, body, sec)),
        (official_figurative_checks, (rep, W, body)),
        (official_framing_checks, (rep, W, intro, blocks)),
        (official_override_checks, (rep, W, kind, p, blocks, sd)),
        (official_gaze_checks, (rep, W, blocks, persons)),
        (official_overshoulder_checks, (rep, W, blocks, persons)),
        (official_negation_checks, (rep, W, body)),
        (official_unused_person_checks, (rep, W, body, persons)),
        (official_crowd_checks, (rep, W, body, sd)),
        (official_text_hint_checks, (rep, W, body, p)),
        (official_residue_checks, (rep, W, kind, p, secs)),
    ):
        try:
            fn(*args)
        except Exception as e:  # 新检查自己的毛病不能让整份 check 报废
            rep.add("HINT", W, "[内部] %s 没跑成：%s（不影响其他检查，请告诉维护的人）" % (fn.__name__, e))


# B16 接尾帧的景别咬合（老李 C18m）+ B19 全队列人物特写占比（老李 C18n）。队列级，只看官方格式的镜头
TL_CLOSE = re.compile(r"(?:pull(?:s|ing)? (?:back|out)|push(?:es|ing)? in|dolly(?:ies|ing)? (?:in|out)|widens?|tightens?)\b[^.]{0,30}?\b(?:to|into)\s+(?:an? |the )?(%s)|\b(?:ends?|settles?|holds?) (?:on|into|at)\s+(?:an? |the )?(%s)" % (SZ_ALT, SZ_ALT), re.I)
FACE_WORD = re.compile(r"\b(?:face|eyes?|lips|mouth|brows?|jaw|expression|gaze|cheeks?|tears?)\b", re.I)
SIZE_NAME = ["extreme wide", "wide", "medium wide", "medium", "medium close-up", "close-up", "extreme close-up"]


def official_tail_size_checks(rep, shots, titles, fmt_flags):
    for i, s in enumerate(shots):
        ref = s.get("firstFrameFrom")
        if not fmt_flags[i] or not isinstance(ref, dict) or ref.get("frame") != "last":
            continue
        j = None
        if "shot" in ref and isinstance(ref["shot"], str):
            j = (i - 1 if i > 0 else None) if ref["shot"] == "previous" else titles.get(ref["shot"])
        elif "shotNumber" in ref and isinstance(ref["shotNumber"], int) and not isinstance(ref["shotNumber"], bool):
            j = ref["shotNumber"] - 1 if 1 <= ref["shotNumber"] <= len(shots) else None
        if j is None or j == i or j >= len(shots) or not fmt_flags[j]:
            continue
        _, blocks_a = shot_blocks(off_parts(shots[j].get("prompt"))[2])
        _, blocks_b = shot_blocks(off_parts(s.get("prompt"))[2])
        if not blocks_a or not blocks_b:
            continue
        ta, tb = no_d(blocks_a[-1][1]), no_d(blocks_b[0][1])
        mb = SZ_RE.search(tb)
        if not mb:
            continue
        start = size_level(mb.group(0))
        mc = TL_CLOSE.search(ta)
        closing = bool(mc)
        if mc:
            end = size_level(mc.group(1) or mc.group(2))
        else:
            sizes = set(size_level(x.group(0)) for x in SZ_RE.finditer(ta))
            if len(sizes) != 1:
                continue  # 上一镜结尾景别说不准，不报
            end = sizes.pop()
        if (closing and end != start) or (not closing and abs(end - start) >= 2):
            ttl = s.get("title") or ""
            rep.add("WARN", "镜%d %s" % (i + 1, ttl[:30]), "[接尾帧·景别] %s：已接上一镜（%s）的尾帧，上一镜结尾是 %s%s，这一镜 [Shot 1] 开头写的是 %s；首帧画面和文字描述对不上，模型会跳变或忽略首帧。把 [Shot 1] 的景别改成和上一镜结尾一致，或这一镜不接尾帧" % (ttl, (shots[j].get("title") or "")[:30], SIZE_NAME[end], "（写了收束动作「%s」）" % re.sub(r"\s+", " ", mc.group(0))[:40] if closing else "", SIZE_NAME[start]))


def official_closeup_ratio(rep, shots, fmt_flags):
    n_all = n_cu = 0
    for s, flag in zip(shots, fmt_flags):
        if not flag:
            continue
        kind, secs, body, sd = off_parts(s.get("prompt"))
        _, blocks = shot_blocks(body)
        text = no_d(blocks[0][1] if blocks else body)
        m = SZ_RE.search(text)
        if not m:
            continue
        n_all += 1
        if size_level(m.group(0)) < 5:
            continue
        persons = off_person_lines(sd)
        subs = set(int(x) for x in re.findall(r"<Subject\s*(\d+)>", text))
        if FACE_WORD.search(text) or (subs & set(persons) and not PART_RE.search(text)):  # 纯道具/局部特写不计
            n_cu += 1
    if n_all >= 8:
        r = n_cu / float(n_all)
        if r < 0.20 or r > 0.45:
            rep.add("HINT", "特写占比", "[特写占比] 官方格式 %d 镜里，主景别是人物特写/大特写的有 %d 镜（%d%%），参考区间 20%%～45%%；%s（区间来自漫剧老李的粉丝反馈，不是 H3 实测，只当参考；必给特写：情绪拐点、关键道具、眼神记忆点、台词重音、反应镜）" % (n_all, n_cu, int(round(r * 100)), "特写太少，情绪落不了地" if r < 0.20 else "特写太多，容易滥用"))


def official_queue_checks(rep, shots, titles, fmt_flags):
    for fn, args in ((official_tail_size_checks, (rep, shots, titles, fmt_flags)), (official_closeup_ratio, (rep, shots, fmt_flags))):
        try:
            fn(*args)
        except Exception as e:
            rep.add("HINT", "队列", "[内部] %s 没跑成：%s（不影响其他检查，请告诉维护的人）" % (fn.__name__, e))


def cmd_check(d, a):
    if not a:
        out("用法: check <queue.json>"); return 1
    path = a[0]
    rep = Rep()
    try:
        with open(path, encoding="utf-8-sig") as f:
            q = json.load(f)
    except Exception as e:
        out("ERROR JSON 无法解析: %s" % e); return 2
    if q.get("version") != "shot-queue-v1":
        rep.add("ERROR", "顶层", "version 必须是 \"shot-queue-v1\"")
    if not isinstance(q.get("title"), str) or not q.get("title").strip():
        rep.add("ERROR", "顶层", "缺 title")
    dfl = q.get("defaults") or {}
    if not isinstance(dfl, dict):
        rep.add("ERROR", "defaults", "defaults 必须是对象"); dfl = {}
    check_mp(rep, "defaults", dfl)
    nbm_on = dfl.get("noBackgroundMusic") is True  # v2026-11-13.1：官方格式靠 non_diegetic_music: N/A，不再要求 true
    if "megapixels" not in dfl and "resolution" not in dfl:
        rep.add("HINT", "defaults", "未设 megapixels，不写的镜头按程序默认 0.50MP；参数要先和用户确认")
    os.path.basename(path).startswith("_compiled_") and rep.add("ERROR", "文件名", "不要以 _compiled_ 开头（会被当成报告）")
    chs = q.get("chapters")
    if not isinstance(chs, list) or not (1 <= len(chs) <= 40):
        rep.add("ERROR", "顶层", "chapters 必须是 1～40 章的数组"); chs = chs if isinstance(chs, list) else []
    shots = []
    for ci, c in enumerate(chs):
        ss = c.get("shots") if isinstance(c, dict) else None
        if not isinstance(ss, list) or len(ss) < 1:
            rep.add("ERROR", "第%d章" % (ci + 1), "每章 shots 至少 1 镜")
            ss = ss if isinstance(ss, list) else []
        for s in ss:
            shots.append(s if isinstance(s, dict) else {})
    titles, ids = {}, {}
    for i, s in enumerate(shots):
        t = s.get("title")
        if isinstance(t, str):
            if t in titles:
                rep.add("ERROR", "镜%d" % (i + 1), "标题重复: %s（接帧靠标题引用）" % t)
            titles.setdefault(t, i)
            if t != t.strip() or "  " in t:
                rep.add("WARN", "镜%d" % (i + 1), "标题首尾或中间有多余空格")
        if "shotId" in s:
            if s["shotId"] in ids:
                rep.add("ERROR", "镜%d" % (i + 1), "shotId 重复: %s" % s["shotId"])
            ids.setdefault(s["shotId"], i)

    deps = {}
    five_info = []
    fmt_flags = []
    raw_prompts = [x.get("prompt") if isinstance(x.get("prompt"), str) else "" for x in shots]  # 展开占位之前的原文
    ep_info = episode_prepare(rep, q, shots)  # 本集设定：先展开占位，之后所有检查看展开后的正文

    def resolve(i, ref, where, field, backward_only=False):
        if not isinstance(ref, dict):
            rep.add("ERROR", where, "%s 必须是对象" % field); return None
        modes = [k for k in ("shot", "shotId", "shotNumber") if k in ref]
        if len(modes) != 1:
            rep.add("ERROR", where, "%s 需且只需 shot/shotId/shotNumber 之一" % field); return None
        if ref.get("frame") not in ("first", "last"):
            rep.add("ERROR", where, "%s.frame 只能 first/last" % field)
        m = modes[0]; v = ref[m]; j = None
        if m == "shot":
            if v == "previous":
                j = i - 1 if i > 0 else None
            else:
                j = titles.get(v)
        elif m == "shotId":
            j = ids.get(v)
            rep.add("HINT", where, "用了 shotId 引用；生产验证过的是 shot:完整标题，先 validate 确认")
        else:
            j = v - 1 if isinstance(v, int) and 1 <= v <= len(shots) else None
        if j is None:
            rep.add("ERROR", where, "%s 找不到来源镜: %r" % (field, v)); return None
        if j == i:
            rep.add("ERROR", where, "%s 引用了自己" % field); return None
        return j

    for i, s in enumerate(shots):
        t = s.get("title") if isinstance(s.get("title"), str) else "?"
        W = "镜%d %s" % (i + 1, t[:30])
        for k in ("title", "prompt", "roleIds", "sceneAssetIds", "seconds"):
            if k not in s:
                rep.add("ERROR", W, "缺必填字段 %s" % k)
        unk = [k for k in s if k not in KNOWN and not k.startswith("_") and k not in ("notes", "shotnotes")]
        if unk:
            rep.add("WARN", W, "未知字段（画布不认，可能被忽略）: %s" % ", ".join(unk))
        roles = s.get("roleIds", [])
        scenes = s.get("sceneAssetIds", [])
        for k, arr in (("roleIds", roles), ("sceneAssetIds", scenes)):
            if k in s and (not isinstance(arr, list) or len(arr) > 6):
                rep.add("ERROR", W, "%s 必须是 0～6 个 ID 的数组" % k)
        if not isinstance(roles, list): roles = []
        if not isinstance(scenes, list): scenes = []
        id_checks(rep, W, s)
        sec = s.get("seconds")
        if "seconds" in s and (not is_num(sec) or not (5 <= sec <= 15)):
            rep.add("ERROR", W, "seconds 必须是 5～15，现在 %r" % (sec,))
        if "aspect" in s and s["aspect"] not in ENUM["aspect"]:
            rep.add("ERROR", W, "aspect 非法: %r" % s["aspect"])
        elif "aspect" not in s:
            rep.add("HINT", W, "未写 aspect，将按默认 9:16")
        sm = s.get("soundMode", "av")
        if sm not in ENUM["soundMode"]:
            rep.add("ERROR", W, "soundMode 只能 av/ambient/silent，现在 %r（auto 属于 generationMode）" % sm)
        check_mp(rep, W, s)
        p = s.get("prompt", "")
        if not isinstance(p, str) or not p.strip():
            rep.add("ERROR", W, "prompt 为空"); p = ""
        if len(p) > 12000:
            rep.add("ERROR", W, "prompt %d 字符，超过 12000" % len(p))
        gm = s.get("generationMode", dfl.get("generationMode", "auto"))
        off_fmt = is_official(p)  # 正本 v2026-11-13.1：只认官方格式（Ref2VA 六段式 / 三栏式），旧格式每镜一条 [旧格式] ERROR
        fmt_flags.append(off_fmt if p.strip() else None)
        # 对白
        dl = s.get("dialogue") or []
        if not isinstance(dl, list):
            rep.add("ERROR", W, "dialogue 必须是数组"); dl = []
        for li, line in enumerate(dl):
            LW = "%s 台词%d" % (W, li + 1)
            if not isinstance(line, dict) or not isinstance(line.get("text"), str) or not line.get("text").strip():
                rep.add("ERROR", LW, "缺 text"); continue
            if "roleId" in line and "speaker" in line:
                rep.add("ERROR", LW, "roleId 与 speaker 不能混用")
            elif "roleId" in line:
                if line["roleId"] not in roles:
                    rep.add("ERROR", LW, "roleId 不在本镜 roleIds 里")
            elif "speaker" in line:
                v = line.get("voice")
                if v is None:
                    rep.add("WARN", LW, "speaker 行缺 voice，建议显式 \"none\"")
                elif not (v == "none" or (isinstance(v, str) and v.startswith("audio:") and len(v) > 6)):
                    rep.add("ERROR", LW, "voice 只能 \"none\" 或 \"audio:素材ID\"，音色描述写进正文")
            else:
                rep.add("ERROR", LW, "需要 roleId 或 speaker")
            txt = line["text"].strip().strip("。！？，…!?,. ")
            if len(txt) >= 3 and txt in p:
                rep.add("WARN", LW, "台词原文也出现在 prompt 里，可能念两遍（台词只放 dialogue）")
        if dl and sm != "av":
            rep.add("ERROR", W, "有 dialogue 时 soundMode 必须是 av")
        if dl and "<d>" in p:
            rep.add("WARN", W, "prompt 里写了 <d> 台词块，编译器还会追加 dialogue，可能重复")
        if "voiceRoleId" in s:
            if s["voiceRoleId"] not in roles: rep.add("ERROR", W, "voiceRoleId 不在 roleIds 里")
            if sm != "av": rep.add("ERROR", W, "设了 voiceRoleId 时 soundMode 需为 av")
        off = s.get("offscreenRoleIds") or []
        if off and (not isinstance(off, list) or any(x not in roles for x in off)):
            rep.add("ERROR", W, "offscreenRoleIds 必须是 roleIds 的子集")
        # 接帧
        ends = {}
        for side in ("first", "last"):
            st, dy = s.get(side + "FrameAssetId"), s.get(side + "FrameFrom")
            if st and dy:
                rep.add("ERROR", W, "%s 端同时给了静态图和视频来源，二选一" % side)
            if dy is not None:
                j = resolve(i, dy, W, side + "FrameFrom")
                if j is not None:
                    deps.setdefault(i, set()).add(j)
            ends[side] = bool(st or dy)
        if (ends["first"] or ends["last"]) and gm != "first-last":
            rep.add("ERROR", W, "设了首/尾帧但 generationMode 不是 first-last")
        if gm == "first-last" and not (ends["first"] or ends["last"]):
            rep.add("ERROR", W, "first-last 模式但没有任何首/尾帧来源")
        if gm == "extend":
            ss_, sv = s.get("sourceShot"), s.get("sourceVideoAssetId")
            if bool(ss_) == bool(sv):
                rep.add("ERROR", W, "extend 需要 sourceShot 或 sourceVideoAssetId 二选一")
            if ss_ and ss_ != "previous":
                j = titles.get(ss_)
                if j is None: rep.add("ERROR", W, "sourceShot 找不到: %r" % ss_)
                elif j >= i: rep.add("ERROR", W, "extend 的 sourceShot 只能指向前面的镜头")
                else: deps.setdefault(i, set()).add(j)
        # 🧪 时间锚点 timeAnchors（2026-10-27 画布新增，未试渲）
        anchors = s.get("timeAnchors")
        n_asref = 0
        if anchors is not None:
            wf = s.get("workflow", dfl.get("workflow", "ultimate"))
            if not isinstance(anchors, list) or not (1 <= len(anchors) <= 4):
                rep.add("ERROR", W, "timeAnchors 必须是 1～4 项的数组"); anchors = anchors if isinstance(anchors, list) else []
            if gm == "extend":
                rep.add("ERROR", W, "timeAnchors 不能与 extend 模式同用")
            if wf not in ("ultimate", "fast"):
                rep.add("ERROR", W, "timeAnchors 只支持终极版/极速版（workflow ultimate/fast）")
            length = 17 * max(7, round((sec * 24 - 5) / 17.0)) + 5 if is_num(sec) else 0
            frames = []
            for ai, an in enumerate(anchors):
                AW = "%s 锚点%d" % (W, ai + 1)
                if not isinstance(an, dict):
                    rep.add("ERROR", AW, "必须是对象"); continue
                at = an.get("atSeconds")
                if not is_num(at):
                    rep.add("ERROR", AW, "缺 atSeconds（秒数）"); continue
                if ("assetId" in an) == ("frameFrom" in an):
                    rep.add("ERROR", AW, "assetId 与 frameFrom 需且只需一个")
                if "assetId" in an and (not isinstance(an["assetId"], str) or PLACEHOLDER.search(an["assetId"])):
                    rep.add("ERROR", AW, "assetId 还是占位/非法")
                if "frameFrom" in an:
                    j = resolve(i, an["frameFrom"], AW, "frameFrom")
                    if j is not None:
                        deps.setdefault(i, set()).add(j)
                if "asReference" in an and not isinstance(an["asReference"], bool):
                    rep.add("ERROR", AW, "asReference 只能是 true/false")
                if an.get("asReference") is True:
                    n_asref += 1
                fr = int(round(at * 24))
                if length and not (1 <= fr <= length - 2):
                    rep.add("ERROR", AW, "%.2f 秒 = 第 %d 帧，超出范围（1～%d 帧，不能是首帧或尾帧）" % (at, fr, length - 2))
                if fr in frames:
                    rep.add("ERROR", AW, "与其他锚点同一帧 %d" % fr)
                frames.append(fr)
            pts = sorted(frames + ([0] if ends["first"] else []) + ([length - 1] if ends["last"] and length else []))
            if any(b - a < 24 for a, b in zip(pts, pts[1:])):
                rep.add("WARN", W, "锚点之间或与首尾帧间隔不足 1 秒（24 帧），画面易提前到位并发僵")
            if anchors and not n_asref:
                rep.add("HINT", W, "锚点图模型看不见，正文用文字写该时刻状态（by about 3 seconds ...），不要写成 <Picture N>")
        # 编号
        pics = [int(x) for x in re.findall(r"<Picture\s*(\d+)>", p)]
        # 只数格式对的 ID：一句描述塞进 roleIds 也会被 len() 算成一张图（2026-11-11 实测曾漏报）
        n_scene_ok = len([x for x in scenes if is_id(x)])
        # 第一集写法和官方格式（v2026-11-13）：角色外观图都占 Picture 编号；只有 v2026-11-13 以前的旧六段式（没有 [Shot 1]）不数
        n_roles_pic = len([x for x in roles if is_id(x)]) if (off_fmt or "subject_definitions:" not in p) else 0
        n_key = (1 if ends["first"] else 0) + (1 if ends["last"] else 0)
        if off_fmt and official_kind(p) == "base":
            # 三栏式（I2VA / FL2VA / L2VA）：对齐句里的 <Picture N> 就是首尾帧（官方指南原句）；画布会不会再挪编号未实测
            if pics and max(pics) > n_key:
                rep.add("ERROR", W, "[官方·对齐句] 正文用到 <Picture %d>，但这一镜只有 %d 张首尾帧；三栏式里 <Picture N> 只指首尾帧" % (max(pics), n_key))
        elif pics and max(pics) > n_scene_ok + n_asref + n_roles_pic:
            rep.add("ERROR", W, "正文用到 <Picture %d>，但实际只有 %d 张参考图（场景图 %d 张%s%s）；Picture 按 sceneAssetIds、再 roleIds 的顺序数，格式不对的 ID 不算图，锚点图默认不占编号" % (max(pics), n_scene_ok + n_asref + n_roles_pic, n_scene_ok, ("、角色外观图 %d 张" % n_roles_pic) if "subject_definitions:" not in p else "", ("、锚点参考图 %d 张" % n_asref) if n_asref else ""))
        elif n_asref and pics and max(pics) > len(scenes):
            rep.add("WARN", W, "用到了锚点参考图的编号，实际编号以「提交前核对」为准")
        for m in FRAME_AS_PIC.finditer(p):
            rep.add("ERROR", W, "把首/尾帧写成了 <Picture %s>；首尾帧不占编号，写 the opening frame / the final frame（否则整链错位）" % m.group(1))
        subs = [int(x) for x in re.findall(r"<Subject\s*(\d+)>", p)]
        vis = len([r for r in roles if r not in off])
        if off_fmt:
            pass  # 官方格式里 Subject 是人和场景的统称，编号和 roleIds 不一一对应，在 official_checks 里查
        elif subs and max(subs) > len(roles):
            rep.add("ERROR", W, "正文用到 <Subject %d>，但 roleIds 只有 %d 个" % (max(subs), len(roles)))
        elif subs and max(subs) > vis:
            rep.add("WARN", W, "<Subject %d> 超过出镜角色数 %d（画外角色不上传外观）" % (max(subs), vis))
        n_img = len(scenes) + vis + n_asref + (1 if ends["first"] else 0) + (1 if ends["last"] else 0)
        if n_img > 9:
            rep.add("ERROR", W, "参考图约 %d 张，超过 9 张上限" % n_img)
        elif n_img > 6:
            rep.add("HINT", W, "参考图约 %d 张，越多越易串味，能少则少" % n_img)
        typ = shot_type(s, roles, scenes, off)
        if not off_fmt and p.strip():
            rep.add("ERROR", W, "[旧格式] 旧格式已停用，请按官方格式重写：这一镜是 %s，%s（正本 v2026-11-13.1，get 提示词 官方格式）" % (typ, "写 Ref2VA 六段式（subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music）" if typ == "Ref2VA" else "写三栏式（%sintegrated_multimodal_description / overall_soundscape / non_diegetic_music）" % ("" if typ == "T2VA" else "对齐句 + ")))
            five_info.append(None)
            zhengben_shot_checks(rep, W, s, p, gm)
            continue
        # 写法
        tail = p[-400:]
        if HOLD.search(tail):
            rep.add("WARN", W, "结尾有定格类句子（hold/End held/settles and holds/定格/静止不动），H3 会让人物冻住；结尾写仍在进行的动作")
        if META.search(p):
            rep.add("ERROR", W, "正文有给模型的元指令（如 dialogue line / 台词1），会被当旁白念出")
        g = glow_hits(p)
        if g > 0:
            rep.add("HINT", W, "出现 glow/bloom/neon 类词，H3 易渲成持续霓虹；写颜色亮度上限并说明何时熄灭")
        if off_fmt:
            official_checks(rep, W, s, p, sec, dl, n_scene_ok + n_asref + n_roles_pic, typ, raw_prompts[i])
            official_five(rep, W, p)
            # v2026-11-23.1：细节清单第 4、5 条（小反应、左右手）官方格式也查（附录第 1 条）；漫剧老李对照并入的检查（B1～B21）
            detail_checks(rep, W, p, sec, dl, official=True, has_role=bool([x for x in roles if x not in off]))
            official_extra_checks(rep, W, s, p, sec)
            five_info.append(None)
            zhengben_shot_checks(rep, W, s, p, gm)
            continue
        if NOBG.search(p) and sm == "ambient":
            rep.add("WARN", W, "写了 no other background sound 又用 ambient，声音要求自相矛盾；删掉这句，声音段只写房间底噪和动作声（不要写 No background music）")
        if not re.search(r"\blight|\blit\b|\d{4}\s?K\b|lamp|lantern|sun|moon|candle|光", p, re.I):
            rep.add("HINT", W, "没看到具体光源描述（源+方向+色温+明暗面）")
        if gm == "first-last" and s.get("firstFrameFrom") and not re.search(r"already (in motion|moving)|continu", p, re.I):
            rep.add("HINT", W, "接尾帧镜建议开头写 continuing from the opening frame already moving")
        if dl and not re.search(r"lips|mouth|口型|嘴", p, re.I):
            rep.add("HINT", W, "有台词但没写口型/闭嘴归属（旧写法；第一集写法 dialogue 留空，台词只写在对白段）")
        # 中文台词密度与结尾标点（第三方实测阈值 3.5 字/秒，待本片验证）
        if dl and is_num(sec):
            cjk = sum(len(re.findall(r"[一-鿿]", x.get("text", ""))) for x in dl if isinstance(x, dict))
            if cjk and cjk / float(sec) > 3.5:
                rep.add("WARN", W, "中文台词 %d 字 / %s 秒 = %.1f 字/秒，超过 3.5（易吞尾字）；%s 秒建议 ≤%d 字，拆句或拆镜" % (cjk, sec, cjk / float(sec), sec, int(sec * 3.4)))
            for li, x in enumerate(dl):
                t_ = (x.get("text") or "").strip() if isinstance(x, dict) else ""
                if re.search(r"[一-鿿]", t_) and not re.search(r"[。！？!?…]$", t_):
                    rep.add("HINT", W, "台词%d 结尾没有 。！？，最后一个音容易丢" % (li + 1))
        # 实测教训（2026-11-06）
        if re.search(r"no (logos?|signs?|lettering|readable characters|written characters)\b|no logos or lettering|(不要|没有|不出现|去掉)[^。新]{0,6}(logo|标志|招牌|商标)", p, re.I):
            rep.add("WARN", W, "写了 no logos / no signs / no lettering / no readable characters 类排除，会抹掉参考图里的投资方 logo/招牌；改为 Any logos, signs and brand marks that appear in the reference pictures stay exactly as they are")
        for li, x in enumerate(dl or []):
            if isinstance(x, dict) and "speaker" in x and re.search(r"[一-鿿]", x.get("speaker") or ""):
                rep.add("WARN", W, "台词%d 的 speaker 是中文名「%s」，会被当台词念出来；改成英文称呼（如 HR woman）" % (li + 1, x.get("speaker")))
        if not dl:
            for m in re.finditer(r"\b(speaks|speaking|talking|talks|says)\b", p, re.I):
                before = p[max(0, m.start() - 25):m.start()].lower()
                if not re.search(r"no one|nobody|nothing|never|not |no-one", before):
                    rep.add("WARN", W, "没有台词却写了 %s，模型会编出听不懂的人声；改成 listening / silent，并写 No voices at all" % m.group(1))
                    break
        if dl and not re.search(r"quiet beat|silent beat|after (the|his|her) last word|after (his|her) line|after she finishes|after he finishes|说完|最后一个字(之后|说完)|话音落下|留白", p, re.I):
            rep.add("HINT", W, "最后一句台词后没写留白；台词排到镜尾易被截断，写 after the last word … the shot ends during this quiet beat（留 1～2 秒）")
        # 实测（2026-11-08）：按秒写，禁止英文复述台词
        if re.search(r"\b(says|tells|asks)\b", p, re.I):
            rep.add("WARN", W, "正文用了 says/tells/asks，会把台词意思再说一遍，模型乱说话；删掉意思，只留 speaks + lips moving continuously to the end of the sentence")
        if re.search(r"does not form words|do not form words|lips part|mouth opens|张嘴|嘴唇分开|嘴微张", p, re.I):
            rep.add("WARN", W, "写了张嘴但不给词，模型会往嘴里填乱码；这一段嘴不说话就不写嘴（第一集写法不写「开口 / 不出声 / 嘴唇闭着」）")
        if is_num(sec) and sec >= 8 and not re.search(r"\d{2}:\d{2}\s*-\s*\d{2}:\d{2}|\d+(\.\d+)?\s*[-–]\s*\d+(\.\d+)?\s*秒", p):
            rep.add("WARN", W, "8 秒以上没有 00:00-00:03 这种时间段，动作和说话会挤在一起；按秒分段，一段一件事")
        if dl and not re.search(r"lips moving continuously to the end of the sentence|嘴(唇)?一直动到(句尾|最后一个字|整句说完|这句话说完|这句说完|这句话说完)", p, re.I):
            rep.add("WARN", W, "有台词但没有整句 lips moving continuously to the end of the sentence（旧写法的要求；第一集写法 dialogue 留空，不写嘴）")
        if re.search(r"\biced\b|\bice cubes?\b|冰块|冰美式|冰拿铁", p, re.I) and not re.search(r"ice[^.]{0,40}no sound|no ice clinking|冰块[^。]{0,20}(不|没有)(发出)?(声|响)", p, re.I):
            rep.add("HINT", W, "画面里有冰饮/冰块但没写冰块声，模型会自动配很响的冰块声；不要就写 The ice makes no sound at all")
        detail_checks(rep, W, p, sec, dl)
        first_style_checks(rep, W, p)
        zhengben_shot_checks(rep, W, s, p, gm)
        dur_flag = duration_checks(rep, W, s, p, sec, dl)
        has_role = [x for x in roles if x not in off]
        if is_num(sec) and 5 <= sec < 10 and has_role and dur_flag is None:  # 能估秒数的听 [时长]，不再推长
            rep.add("HINT", W, "秒数 %s < 10：有戏的镜头偏好 10～15 秒；插入镜、空镜、过渡镜 5～6 秒就够，不用凑（正本 时长怎么定）" % sec)
        five_info.append(five_checks(rep, W, s, p))
        p_nodlg = re.sub(r"对白[（(][^\n]*", "", p)  # 第一集写法：对白段里的引号是台词，不算画面文字
        quoted = re.findall(r"[\"“]([^\"”]*[一-鿿][^\"”]*)[\"”]", p_nodlg)
        if quoted:
            rep.add("WARN", W, "对白段以外的引号里有中文：%s —— 会被渲成画面文字。台词只写在「对白（中文普通话，口型同步）」那一行" % "、".join(q[:12] for q in quoted[:3]))
    n_off = sum(1 for x in fmt_flags if x)
    if n_off and nbm_on:
        rep.add("HINT", "defaults", "官方格式镜头要原样提交：画布支持之前，noBackgroundMusic true 会给正文追加「这段听到的」和 Audible audio… 句子；不要配乐靠 non_diegetic_music: N/A（正本 v2026-11-13）")
    check_table(rep, path, shots, "--skip-table" in a)
    roled = [i + 1 for i, x in enumerate(shots) if isinstance(x, dict) and (x.get("roleIds") or []) and not (x.get("sceneAssetIds") or [])]
    if roled and len(roled) == len([x for x in shots if isinstance(x, dict) and x.get("roleIds")]):
        rep.add("WARN", "场景", "所有有人物的镜头都没绑场景参考图（sceneAssetIds 为空），每镜房间布局会各画各的；绑上本场的场景母版")
    consistency_checks(rep, shots)
    zhengben_queue_checks(rep, shots, path, dfl, q)
    five_queue_checks(rep, shots, five_info)
    # v2026-11-13.1：同性别区分（gender_checks）、开场空白（opening_gap_checks）、念字（read_aloud_checks）随旧格式退休，不再调用
    tail_checks(rep, chs, path)
    official_queue_checks(rep, shots, titles, fmt_flags)  # v2026-11-23.1：已接尾帧的景别咬合、全队列人物特写占比
    if ep_info:
        episode_near_miss(rep, shots, ep_info)
        episode_merge(rep, shots, ep_info)
    # 环检测
    color = {}

    def dfs(u, stack):
        color[u] = 1
        for v in deps.get(u, ()):
            if color.get(v) == 1:
                rep.add("ERROR", "依赖", "接帧成环: %s" % " → ".join(str(x + 1) for x in stack + [u, v]))
            elif not color.get(v):
                dfs(v, stack + [u])
        color[u] = 2
    for u in list(deps):
        if not color.get(u):
            dfs(u, [])
    # 输出
    order = {"ERROR": 0, "WARN": 1, "HINT": 2}
    rep.items.sort(key=lambda x: order[x[0]])
    cnt = {k: sum(1 for x in rep.items if x[0] == k) for k in order}
    chains = sum(len(v) for v in deps.values())
    out("队列: %s ｜ %d 镜 ｜ 接帧依赖 %d 条" % (q.get("title", "?"), len(shots), chains))
    secs_ = [x.get("seconds") for x in shots if is_num(x.get("seconds"))]
    out("时长: 合计 %s 秒（%d 镜）；用户给了目标总时长的，交付时写「合计 X 秒 / 目标 Y 秒」，偏短要补" % (("%g" % sum(secs_)), len(secs_)))
    out("结果: ERROR %d ｜ WARN %d ｜ HINT %d" % (cnt["ERROR"], cnt["WARN"], cnt["HINT"]))
    show_hint = "--all" in a
    for lvl, w, m in rep.items:
        if lvl == "HINT" and not show_hint:
            continue
        out("%-5s %s：%s" % (lvl, w, m))
    if cnt["HINT"] and not show_hint:
        out("（另有 %d 条 HINT，加 --all 查看）" % cnt["HINT"])
    out("静态校验通过不等于能导入/能出片：再用 validateOnly 干跑看 compiledShots，并先投第一镜小样。" if not cnt["ERROR"] else "有 ERROR，不能投递。")
    return 1 if cnt["ERROR"] else 0


CMDS = {"list": cmd_list, "get": cmd_get, "find": cmd_find, "skeleton": cmd_skeleton, "template": cmd_template,
        "vocab": cmd_vocab, "check": cmd_check, "expand": cmd_expand}


def main():
    a = sys.argv[1:]
    if not a or a[0] not in CMDS:
        out(__doc__); return 0
    return CMDS[a[0]](load(), a[1:]) or 0


if __name__ == "__main__":
    sys.exit(main())
