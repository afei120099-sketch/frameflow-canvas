# h3q 检查说明（给画布和维护 h3q 的人）

> 从正本 v2026-11-13.3 原样移出（2026-11-18）。写提示词看正本即可；这里是每条检查的判断办法和报错格式。画布卡片依赖这些格式，不要改。

## 官方格式

- h3q：正文出现两个以上六栏栏目名就按官方格式查，消息前缀 `[官方·六栏]` `[官方·Subject]` `[官方·台词]` `[官方·切镜]` `[官方·声音]` `[官方·中文]` `[官方·追加句]` `[官方·禁止句]` `[官方·闭嘴]` `[官方·summary]`，五项沿用 `[五项·类别]`。**旧格式已停用**（v2026-11-13.1，用户原话「旧格式不用了」）：旧格式每镜报一条 ERROR `[旧格式] 旧格式已停用，请按官方格式重写：这一镜是 <类型>，写 …`，其余旧格式的检查不再跑。画布卡片按这些前缀分组，格式不要改。

## 送角色声音

  - 每句台词前：`<Subject 4>, a man in his fifties with a low, slightly rough voice (S1), using the voice timbre referenced from <Audio 1>, asks under his breath: <d>[Chinese] 报告改完了吗？</d> He closes his mouth and keeps his eyes raised.`

## 接尾帧

- h3q check：上面四条按关键词都对上、这一镜还没接时报 HINT，格式固定 `[接尾帧] 可以考虑接上一镜尾帧：<上一镜标题> → <这一镜标题>；理由：…`，画布卡片按它做「一键接上」，这个格式不要改。判断办法：同一章相邻两镜、场景图第一张一样、roleIds 一样、标题里没有反打 / 过肩 / 主观 / 插入 / 空镜、机位那句（对照表「机位：」或正文）景别角度焦段一样、上一镜结束和这一镜开始的站位 / 姿势 / 左右手拿的东西 / 服装状态对得上、这一镜没写换衣。已经写了 firstFrameFrom、静态首尾帧或时间锚点的不报；连着第 4 次接的不报。拿不准就不报，只提示不拦，接不接由人定。

## 时长

- h3q check 按同一套算法估秒数（查偏短用下限：动作 1.5、小反应 0.5；查偏长用上限：动作 2.5、小反应 1；建议秒数用中间值：动作 2、小反应 0.75，同一句里第二个起的动作算一半），只报 WARN，不拦截入队：
  - `[时长] 偏长：…；建议约 N 秒`（偏长就是掺水）：上限估计比实写秒数少 3 秒以上；或某一段超过 3 秒却没有新变化；或没有角色的镜头超过 6 秒（内容估计也不超过 6.5 秒时）。有角色的镜头消息里给两个方向：「要么保留 M 秒，把 X-Y秒 补成有内容的（加一个看得见的动作、反应、表情变化或机位变化）；要么缩短，建议约 N 秒」；没有角色的插入镜只写「缩短，建议约 N 秒」。
  - `[时长] 偏短：…；建议约 N 秒`：下限估计比实写秒数多 2 秒以上（说话太密、动作太多）；15 秒也放不下会写「要拆镜」。
  - N 是 5～15 的整数，永远在消息最后。画布卡片显示这条消息，并用 `建议约 (\d+) 秒` 取出 N 做「改成 N 秒」按钮（按钮只管缩短/加长这一个方向，补内容由人改正文）；这个格式不要改。估计是按关键词算的，只当提醒：确实需要停顿（情绪留白、等台词落地）就保留原秒数，在对照表里写一句为什么。

## 五项

**每镜必写五项**（v2026-11-13：官方格式照样必写，用英文写进风格句和每个 [Shot]，h3q 用英文关键词查，前缀不变）（v2026-11-11.4，用户定：这五项最影响画面，每一镜都要写、要写对；h3q check 报 ERROR，消息开头带类别，画布卡片拦住不让投）。标准写法：
| 代号 | 怎样算写了 | 怎样算写对（错了也 ERROR） |
|---|---|---|
| `[五项·风格胶片]` | 有一句风格胶片句，含胶片或颗粒（如「写实真人电影质感，Kodak Vision3 250D 胶片颗粒，…」） | 整集只用一种胶片型号（不能这镜 250D 那镜 500T）；第一集写法里这一句整集逐字一致 |
| `[五项·光线]` | 有一行光线句：光源（灯、日光、窗光…）+ 位置方向 + 色温（暖黄/冷白或 K 数）+ 亮在哪 | 不写「不暗 / 不死黑」这类否定句，不写「只有一盏灯 / 唯一光源」。同一地点逐字照抄（借同一组场景图拍走廊等别处时可以不同，所以这条只提示不拦） |
| `[五项·景别焦段]` | 有一个景别词（大特写 / 特写 / 近景 / 中近景 / 中景 / 全景 / 远景，英文 close-up / medium / wide），**并且**有焦段或景深（35mm 等效、景深到…、虚化） | 机位那一句里只能有一个主景别；要变景别就写清从哪推到哪 |
| `[五项·构图]` | 写了主体在画面哪里（画左 / 画右 / 画中 / 上三分之一）**并且**有层次：前景、中景、后景（背景）或「景深到…、后面虚化」至少一样 | 同上，缺哪样报哪样 |
| `[五项·运镜机位]` | 写了机位高度或角度（平视 / 仰 / 俯 / 斜 / 侧 / 镜头在桌沿下）**并且**写了镜头怎么动（固定 / 推 / 拉 / 跟 / 摇） | 同一句里不能既「机位固定」又「镜头推近 / 跟拍 / 手持」；要变就分时间段写 |
机器判断是按关键词找，判断不了的情况一律放过（不冤枉好队列）。参考写法「仰，镜头在桌沿下，中近景，机位固定。中近景，35mm 等效，景深到两个人的脸，后景…虚化」一句就把景别、焦段、角度、运动都写全了，照这个格式写最稳。

## 漫剧老李对照并入（v2026-11-23.1）

> 来源：部分检查规则参考漫剧老李 manju-laoli-skill（MIT License，署名见 `THIRD_PARTY_NOTICES.md`），编号 B1～B21 + 附录三条。老李的实测来源是 Seedance，H3 上都没验证过。
> 通用约定：全部只在**官方格式**下跑；一律只报 **WARN 或 HINT，不拦截**；按 `[Shot N]` 切块判断，`<d>` 里的台词原话不参与（`[台词语感]` 和台词时长除外）；拿不准宁可不报。没有改任何已有报错的格式。某个新检查自己出错时只出一条 HINT `[内部] 函数名 没跑成：…`，不影响其他检查。新增前缀画布可以按它分组，格式不要改。

- **B1 `[台词语感]`**（WARN / HINT，只报不改，台词已批准的先问用户）：只扫 `<d>[Chinese] …</d>` 里的原话。WARN：命中书面虚词（是否 因此 从而 鉴于 予以 加以 可否 何以 颇为 甚为 以及 然而 由于 进行）；一句（按 。！？ 切）≥20 个汉字且句内没有 `，、；…—`；一条 ≥40 个汉字且没有 `啊呢吧吗呀哦嘛啦哈`。HINT：以称呼加逗号开头（`老X，` `小X，`，或 X 总/哥/姐/叔/姨/爷/师傅/老师/经理/主任/医生/先生/女士/同学/局长/董事长 加逗号；Subject 行引号里写了中文名的也算）。官方格式的 Subject 行是英文、取不到中文人名，所以只认称呼类，漏报比误报好。格式：`[台词语感] <d>…</d> 有书面腔用词「是否」；…，听着像书面语；口语、短句、一次一个信息；台词已批准的先问用户，不要自己改`；HINT 为 `[台词语感] <d>…</d> 以喊名字/称呼开头，听着像旁白点名；…`。（附录第 3 条「喊名字开头」并入这里。）
- **B2 官方格式整镜台词时长**（WARN，沿用 `[时长] 偏短`）：整镜所有 `<d>` 的汉字数 ÷ 语速 + 标点停顿 + 末尾 1 秒。语速默认 3.5；某句 `<d>` 前面（上一句 `</d>` 之后、最多 160 个字符）含 whispers / under his breath / word by word / murmurs / mutters 用 3.0，含 shouts / rapidly / talking over / yells 用 5.0（两种都有取 5.0，少报）。停顿：`，、` 各 0.2；`。？！` 各 0.4；`……` 0.5（不再另算句号）。总和 > seconds 就报；N = 总和向上取整、夹在 5～15、不小于 seconds+1（最多 15）；总和 >15 加「15 秒也放不下，要拆镜」。seconds 不在 5～15、或没有汉字台词不报。官方格式以前不跑 `[时长]`，不会和旧的重复。格式：`[时长] 偏短：N 字台词（字数÷语速 a 秒 + 标点停顿 b 秒 + 末尾留白 1 秒）整镜估计至少要约 c 秒，只写了 S 秒；建议约 N 秒`，结尾仍是「建议约 N 秒」，画布「改成 N 秒」按钮照用。
- **B3 `[修辞]` `[虚假精度]`**（HINT）：去掉 `<d>` 后的 `[Shot N]` 块正文（v2026-11-23.2：不扫第一个 `[Shot]` 之前的开头风格段，那是统一模板；没有 `[Shot]` 标记就不查；函数 `official_figurative_checks`）。`[修辞]`：`like a/an/the`、`as if`、`as though`、`resembl…`、`shaped like`、`presses like`、`nailed to/onto the floor/ground`，列前 3 处原句，提示「人物姿态、动作、光、影、情绪不用比喻；材质、形态类比喻（如雾 like a solid pale wall）可以保留，确认它就是想画成的样子」。`[虚假精度]`：`\d+%`、`\d mm of pupil/shake/movement`、`focal plane locked/fixed`、`micro-breath…`。
- **B4 `[景别内容]`**（WARN / HINT）：每个 `[Shot]` 块里，特写（含大特写，不含中近景）同时出现 chest / waist / hips / legs / knees / feet / shoes / full body / whole body / walks / kneels / steps forward… / runs toward… → WARN；动作词前紧跟 twists / drives / pushes off / rotates / tenses / braces 的发力链不算；块里写了 pulls back / zooms out / widens / reveals / dolly out / cranes 这类景别会变的不查。中近景（medium close-up / bust shot）同时有 full body / full height / both of them standing → WARN。块里有 `<d>`，且镜头收在手/道具局部（`close-up of his hand/fingers/sword/sheath/ring/document/phone`、`insert shot`、`macro`），块内没有 face / mouth / lips（台词后的 closes his mouth 不算）→ WARN。特写里有 slams / leaps / bursts into laughter / wide-eyed stare → HINT。格式：`[景别内容] [Shot 2] 是特写，却写了「chest、walks」；特写装不下身体和走动，…`。
- **B5 `[分镜五项]`**（WARN / HINT）：有 2 个以上 `[Shot]` 时，各块自己要有景别词、运镜词、机位角度词（用 `[五项·…]` 同一套关键词；第 1 块可以借开头风格段）。整段哪块都没写的不报（交给 `[五项·…]` ERROR）；开头风格段写了 `every shot / each shot / all shots / throughout` 这类全局句并且含这项关键词的，算都写了。WARN 格式：`[分镜五项] [Shot 2]、[Shot 3] 没写机位角度；官方格式每个 [Shot] 都写景别、机位角度、运镜，…`。HINT：块里的第一个景别是特写/大特写、块内焦段全 ≤35mm；或是全景/远景、焦段全 ≥85mm（`35mm film` 不算焦段）。**用的是 `[分镜五项]` 而不是 `[五项·…]`，是为了画布不会把这些 WARN 当成拦截的五项 ERROR。**
- **B6 `[参考图状态]`**（WARN）：Ref2VA 六段式、subject_definitions 里有 `<Picture N>`；某个 `[Shot]` 里出现 takes off / removes / pulls off / unbuttons / sets down / puts down / slips off / takes out，后面 40 个字符内有 helmet / hat / cap / glasses / coat / jacket / scarf / mask / gloves / necklace / ring / watch / bag（或「takes his hat off」写法），而整份 prompt 没有 override / instead of / no longer wearing / bare / not wearing / without the → WARN，每镜只报第一处。格式：`[参考图状态] [Shot 2] 写了「…」，可能和角色参考图叠加（…）；在该角色的 subject_definitions 行和这一镜写明偏离并以本镜为准，…`。
- **B7 `[视线]`**（HINT / WARN，和现有 `eyes fixed on <Subject N>` 写法有冲突，🧪 待小样验证，现有规则不改）：HINT：块是单人景别（close-up / medium close-up / single），没有 over-the-shoulder / two-shot / both / all three，块里有 ≥2 个人物 Subject，并且写了 looks at / eyes fixed on / gaze toward <另一个人物 Subject>。WARN：同一个 `[Shot]` 里 `then looks/glances/turns his head…` 出现 ≥2 次，或出现 scans / sweeps his gaze across。（比老李的 `(then|and then) (turns|looks|glances)` 窄：身体转身不算，少报。）
- **B8 `[构图层次]`**（WARN / HINT）：块里有 over-the-shoulder / over <Subject N>'s left|right shoulder：没写 foreground → HINT；写了「over <Subject N>'s right shoulder」，却在含 foreground 的句子里把同一个 Subject 放在 right（扣掉 left/right shoulder 之后只剩同一个方向词）→ WARN（越过右肩应在画面左前景，越过左肩应在右前景）。不是过肩的块里有 ≥2 个人物 Subject、又没有 foreground / background / blurred / out of focus / behind / midground → HINT「人物层次没标」（双人同清晰的中景可以不管）。
- **B9 `[否定词]`**（WARN；附录第 3 条 no logos 并入这里）：去掉 `<d>` 后的 `[Shot N]` 块正文（v2026-11-23.2：不扫开头风格段，没有 `[Shot]` 标记就不查；函数 `official_negation_checks`）。先单独查 `no logos / no signs / no lettering / no readable characters` → WARN，建议改成 `Any logos, signs and brand marks that appear in the reference pictures stay exactly as they are`；再把 `[官方·禁止句]` 已经报过的 no music / no speech 抹掉；其余命中 `no|not|never|without|doesn't|does not|don't|avoid|free of|absence of` + 一个词的，列前 3 处，总数写在前面。白名单：not only、no longer、never appears in frame、no cuts（标准开头句「with no cuts」）、without cuts。**先 WARN 观察一轮误报，白名单以后再补。**
- **B10 `[官方·Subject]`**（WARN）：subject_definitions 里的人物行（v2026-11-23.2 收窄，函数 `off_person_lines`：只看 `<Subject N>` 之后的头 60 个字符，里面要有 man / woman / boy / girl / years old / aged / in his|her，且这个人物词后面不是所有格 's——如 the lotus girl's small boat 是船不是人；逗号前没有 room / office / street / hall 等场景词）带 `<Picture N>`，而 detailed_description 里一次都没有 `<Subject N>` → WARN「定义了、也绑了参考图，正文里却一次都没出现」。场景行不查。
- **B11 `[背景人物]`**（HINT）：群体词（two / three / four / several / a few / some / the + students / men / women / people / guests / colleagues 等）后 40 个字符内有 raise / wave / cheer / nod / clap / laugh / point / whisper / turn，且同一句没有 only / the others / the rest / one of / while the other → HINT。场景（subject_definitions 或正文）含 classroom / canteen / street / market / lobby / open-plan / bar / station / square，正文又写了 no other people / nobody else / only these two / empty room / deserted 之类 → HINT。（比老李的 `empty` 窄：`empty hands`、`empty chair` 不算。）
- **B13 `[反光道具]`**（HINT，🧪 待小样验证）：同一句里既有 jade / pendant / bracelet / bangle / ring / necklace / gem / jewel / brooch / mirror / locket，又有 lit by / catches the light / reflect… / glint / gleam / glow / shine / flame / candlelight / lamplight。不影响 kb 里「一处材质高光（刀刃、水面）」的写法。
- **B14 `[接触路径]`**（HINT）：`slides/runs/traces/glides/drags/strokes/sweeps/trails + his/her/a/the + hand/fingers/fingertips/palm + from/along/across/over`，同一句后文还有 to / until / toward。
- **B15 `[假表演词]`**（HINT）：suddenly widens/stares、wide-eyed stare、mechanical smile、robotic、bursts into tears、sobs loudly/uncontrollably、screams、yells、shouts at the top…、eyes darting、nods vigorously/repeatedly、shakes his head repeatedly/rapidly。
- **B16 `[接尾帧·景别]`**（WARN，队列级，只查写了 `firstFrameFrom`（frame last）、两镜都是官方格式的镜）：上一镜最后一个 `[Shot]` 的结尾景别 vs 这一镜 `[Shot 1]` 的第一个景别，按阶梯（extreme wide 0 < wide 1 < medium wide 2 < medium 3 < medium close-up 4 < close-up 5 < extreme close-up 6）。上一镜写了收束动作（pulls back to / pushes in to / dollies out to / widens to / tightens to + 景别，或 ends|settles|holds on + 景别）却和这一镜开头不相等 → WARN；没写收束动作、结尾只有一种景别、两边相差 ≥2 档 → WARN；上一镜结尾景别说不准就不报。**前缀是 `[接尾帧·景别]` 而不是 `[接尾帧]`，不会被画布「一键接上」的 `[接尾帧] 可以考虑接上一镜尾帧：A → B` 解析误认。**
- **B17 `[文本残留]`**（WARN）：①第一行不是栏目名（六栏式第一行必须是 `subject_definitions:`；三栏式是 `integrated_multimodal_description:` 或对齐句）；②`non_diegetic_music` 里空行之后还有 ≥40 字符的话；③`TBD / TODO / to be added / placeholder / as before / same as the previous shot / let me know / hope this helps / Here is / Sure, / Certainly / Of course`（附近 40 个字符有 opening frame / same outfit 的不算）；④`J-cut / L-cut / match cut / sound bridge / 180 degree rule / axis line / ST001 / CL001 / MAP001`。中文占位语（同上、待定、某角色）已经被 `[官方·中文]` ERROR 兜住，这里不重复。
- **B19 `[特写占比]`**（HINT，队列级）：官方格式、能认出主景别的镜 ≥8 个时，取各镜 `[Shot 1]` 的第一个景别，统计特写/大特写里「有脸（face / eyes / lips / mouth / brow / jaw / expression…）或有人物 Subject 且不是手/道具局部」的占比；<20% 或 >45% → HINT。区间来自老李的粉丝反馈（25%～40%），放宽了，不是 H3 实测。
- **B20 `[道具状态]`**（HINT）：umbrella / parasol / fan / lid / box / book / folding 前后 50 个字符内没有 open / opened / closed / folded / furled / shut；`hand/pass/slide/push/reach … through/out of … window/gap/slot/crack`；正文有 ancient / imperial / hanfu / wuxia / xianxia / Tang|Song|Ming dynasty|era|period|style，又出现 phone / smartphone / car / headlight / power line / utility pole / jeans / sneakers / plastic / zipper / LED（姓 Song 的人名不算）。
- **B21 `[并列主体]`**（HINT）：`hand/fingers/eyes/lips and her/his/the face/head in/together/side by side`、`face/head and her/his/the hand(s) in/together`；句首（或 `[Shot N]` 后）的 `This/That/These/Those + hand/face/man/woman`。
- **B12（标志姿态显式交接）、B18（站位写依托物）不做机检**，需要语义判断；规则写在正本和 kb。

**附录三条（h3q 自己的缺口）**
1. `detail_checks` 现在官方格式也跑，只跑细节清单第 4、5 条：detailed_description（三栏式是 integrated_multimodal_description）里没有任何表情/身体小反应词（PERF 词表 + v2026-11-23.2 扩充的英文词根 `PERF_EN`：squint / grin / smil / smirk / frown / brow / lips / purse / bite / swallow / sigh / exhal / breath / blink / glanc / nod / tilt / shrug / shoulder / jaw / tighten / clench / flinch / laugh / chuckle；blush 不算）→ 官方格式降为 HINT（旧格式仍 WARN；函数 `detail_body_checks`）`没看到任何表情或身体小反应…`（没有出镜角色的空镜、插入镜不查）；`in his hands / with her hand / in hand` 附近 40 个字符没有 left / right / both → WARN `「…」没写左手还是右手…`。dialogue 非空、六段字段、旧六段式、summary 太空、分秒时间段这些旧格式专属判断在官方格式下不跑（官方格式有自己的 `[官方·…]`），所以不会重复报、也不会误报。
2. `consistency_checks` 支持官方格式：①同一角色（取 `<Subject N> is <名字> from <Picture N>` 里的名字，只比人物行，场景行不比）在不同镜的 Subject 整行不一致 → WARN `角色 X 的 Subject 句有 N 种写法…`（先把 `<Picture N>` / `<Subject N>` 的编号抹成统一写法再比，因为编号会随每镜图数变）；②同一张场景图（`sceneAssetIds[0]`）下，开头风格段（`[Shot 1]` 之前）里含光源词的句子不一致 → HINT `[官方·光线] …`（只提示：同一张场景图常被借去拍别处；光线写在 subject_definitions 场景行里或 `[Shot]` 里的不比）。风格块 `[style vN]` 是旧写法，官方格式不比。
3. `no logos` 排除并入 B9；台词「喊名字开头」并入 B1。

