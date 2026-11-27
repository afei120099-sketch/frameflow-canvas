/**
 * 「复制卡片功能说明」：发给写队列的 AI。讲清镜头卡片怎么读队列、怎么检查，让 AI 写出来的队列一次过检查。
 * 提示词写法以正本 %FRAMEFLOW_H3_TOOLS%\SKILL_h3-video.md（「第一集写法」）为准，这里只做摘要。
 * 规则和 lib/shot-card-checks.ts（画布独有检查）、lib/h3q-report.ts（正本 h3q）、lib/shot-card-breakdown.ts、lib/shot-queue-keyframe.ts 一致；改那些文件时同步改这里。
 * 完整度类别清单来自 lib/zhengben-categories.ts（同一张表），不在这里另写。
 */
import { categoryGuideText, ZHENGBEN_CATEGORY_VERSION } from "./zhengben-categories.ts";

export const SHOT_CARD_GUIDE = `# 画布「镜头卡片」说明（写 shot-queue-v1 队列的 AI 请照这个写）

规则以正本 %FRAMEFLOW_H3_TOOLS%\\SKILL_h3-video.md 为准（写法：在 %FRAMEFLOW_H3_TOOLS% 下运行 python h3q.py get 提示词 第一集写法；写完跑 python h3q.py check <队列.json>）。这份说明只是摘要，和正本不一致时听正本。

## 0. 写法：MiniMax 官方 Ref2VA 六段式（正本 v2026-11-13 起，新队列一律这样写）
细则：在 %FRAMEFLOW_H3_TOOLS% 下运行 python h3q.py get 提示词 官方格式；照范本 %FRAMEFLOW_H3_TOOLS%\\范本\\官方格式_示例_O1O2\\ 和 %FRAMEFLOW_H3_TOOLS%\\范本\\示例项目_EP02v5_L03_官方格式\\ 写。
- 正文六栏依次是 subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music，栏目名英文原样写在行首加冒号，内容全用英文；只有 <d> 里的台词和画面上看得见的字用中文。
- subject_definitions 先定义 <Subject N>（场景、人物各一个，从 1 连续编），写明来自哪张 <Picture N>；后面一律用 <Subject N>，不写名字。卡片参考图格子会显示每张图对应哪个 Subject。
- 台词写成「<Subject 4>, a man in his fifties with a low voice (S1), asks: <d>[Chinese] 又绕回原样了？</d> He closes his mouth …」；S1、S2 按第一次出声先后编。dialogue 字段留空 []。卡片会列出每句台词的说话人编号和 Subject。
- 换镜头写「[Shot 2] At 00:04.000, the shot cuts to …」，不写「0-3秒」时间段。
- 不要配乐就在 non_diegetic_music 写 N/A，不写 no music 这类禁止句。
- **画布对官方格式原样提交**：不加禁背景乐的「这段听到的」和结尾英文句，不加台词 / 声音追加段，不改正文；默认不送角色声音defaults.noBackgroundMusic 勾不勾都一样，配乐只看 non_diegetic_music。
- 🧪 官方格式要送角色声音：这一镜写 voiceRoleIds（按 <Audio 1>、<Audio 2> 的顺序列说话角色 ID，最多 3 个），画布把每人的主声音截前 8 秒按顺序送成 <Audio 1>…；正文自己写 <Audio N>（subject_definitions 末尾写「<Audio 1> is the voice-timbre reference for <Subject 4> (S1).」，summary 任务类型写 [reference generation + audio reference]，retention_analysis 加「<Audio 1>: reference - …」，台词前写 using the voice timbre referenced from <Audio 1>,）。voiceRoleIds 人数和正文 <Audio N> 个数对不上、或有人没主声音，卡片拦住。
- 检查：h3q 的 [官方·…] ERROR 照样按单镜拦；画面五项用英文写（Kodak … film grain、light、close-up + 35mm / depth of field、on the left of the frame + background、eye level / low angle + fixed camera），h3q 没跑成时画布按同一套英文词兜底；下面第 2 条中文写法的检查对官方格式不判。旧格式队列 h3q 会多一条 [旧格式] 提醒，卡片顶部醒目显示。

用户会把你写的队列 JSON 放进画布的「镜头卡片」。卡片会把每一镜拆成：参考图 / 关键帧 / 参数 / 剧情 / 视频，并在渲染前自动检查写错和漏写。提交给 H3 的是你写的正文原文，画布不改写、不追加人名或声音录音。只输出 JSON。

## 1. 队列骨架
{"version":"shot-queue-v1","title":"《剧名》EP01 v1","defaults":{"workflow":"ultimate","generationMode":"auto","megapixels":0.88,"seed":"random","noBackgroundMusic":true,"keyframe":{"look":"全集共用画风（英文，可选）","count":3}},"chapters":[{"title":"01｜章节名","shots":[]}]}
- defaults.noBackgroundMusic 必须是 true。
- 每镜 title 全队列唯一，建议「EP01-v1-L01｜短描述」。卡片的视频、接帧、忽略记录都按 title 对应：改提示词时 title 一字不改。
- 每镜必填：title、prompt、roleIds（角色 ID 数组，可空）、sceneAssetIds（场景图 ID 数组，可空）、seconds（5～15）、aspect（9:16 等）、soundMode（av / ambient / silent；有台词用 av）。
- dialogue 一律留空 []（或不写）。台词只写在正文「对白」那一行（见第 2 条）。
- 可选：tuning（"default" 速度优先 / "understanding" 理解优先，打斗或动作多的镜头用理解优先，只对终极版有效）、workflow、megapixels、firstFrameFrom、lastFrameFrom、keyframe（见第 4 条）。

## 2. 旧格式 prompt 怎么写（第一集写法，正本 v2026-11-13 起停用，只给旧队列对照；中文，一段一行，不写六段字段名、不写方括号标签）
参考说明（编号与提交顺序一致）：<Picture 1>是张三，……的32岁男人，只用于张三的脸、发型和服装；<Picture 2>是李四，……只用于李四的脸、发型和服装；<Picture 3>是场景图，只用于……的布局与光线，不用于人物。每个人物严格保持各自参考图的外观，不要互换脸。
写实真人电影质感，……（风格、场景、开始站位、重要道具，站位写成「他在画左，坐在椅子上」）
主要动作：一句话。
0-3秒：……（景别、动作、表情；用他 / 她）
3-6秒：……说话。
6-9秒：…… 最终状态：……
声音：房间底噪、动作声。
对白（中文普通话，口型同步）：张三（平淡）：“台词。” 李四（平静）：“台词。”
画面要求：……
- 人名只许出现在参考说明的「是张三，只用于」、对白行和设定档光线句。动作段、声音段、头发句、衣服句写他 / 她。
- 不写「开口」「不出声」「嘴唇闭着」：这些会被当台词念出来。说话的那段写「说话」，不说话的段不提嘴。
- 声音段只写房间底噪、对白和动作声。不写「没有背景音乐 / 无配乐 / No background music / soundtrack」，点名就会配上音乐。
- 说话那段的秒数 ≥ 台词字数 ÷ 3.5；最后 1～2 秒留还在进行的动作。
- Picture 编号按画布实际输入顺序（干跑或看「生成信息·实际输入顺序」核对）。
- 剧情格只收「人在做什么」；景别、机位、光线会自动分到别的格子。一个时间段里别只写「看着 / 停在」，要有看得见的动作。

## 3. 提示词完整度（卡片每镜下面一排类别标签）
每个标签三种状态：写了 / 漏写 / 不适用，点开能看到正文里对应的原文。卡片顶部有整集汇总表，列出哪几镜漏了什么。
**画面五项·必写（会拦）**：风格胶片、光线、景别焦段、构图、运镜机位。任何一项在某镜漏写或写错，这一镜算写错（红），「渲染这一镜」点不了；「全部镜头入队」「本章入队」和收件箱自动入队只要有一镜不过就整批不提交，并列出哪几镜哪项不过（收件箱写进 _status.json 的 cardChecks.gate）。判定以正本 h3q check 的 [五项·风格胶片] [五项·光线] [五项·景别焦段] [五项·构图] [五项·运镜机位] ERROR 为准；h3q 没跑成时用卡片的关键词判断兜底，并写明是兜底。本集设定占位 {{本集.风格}} / {{本集.光线.场景名}} 由 h3q 先展开再查，不算漏写。没有一键强行入队；只有用户本人在卡片里点「我确认没问题」并写理由才放行那一镜（只对当时那段正文有效）——队列 JSON 里写任何确认 / 跳过检查字段都没用，别写。怎样算写到：
- 风格胶片：风格块写胶片和色彩，如「写实真人电影质感，Kodak Vision3 250D 胶片颗粒」，整集逐字复用。
- 光线：光源、方向、亮在哪一侧，同一场景从设定档逐字复制（白天还是夜里、暖还是冷前后一致）。
- 景别焦段：景别 + 焦段 + 景深三样都要有，如「中近景，35mm 等效，浅景深，后景轻微虚化」。
- 构图：主体在画面哪里（左三分之一 / 居中 / 上三分之一），前景、中景、背景各是什么。
- 运镜机位：机位角度和运镜都要有，如「平视，机位固定」「低机位仰拍，缓推」（h3q 只写「机位固定」没有角度会报错）。
以正本为准。其余类别只标出来，不拦截入队。类别按正本 ${ZHENGBEN_CATEGORY_VERSION} 的「第一集写法」七段和「细节清单」十条：
${categoryGuideText()}
判断靠关键词，会有误报；写法对不对以正本 h3q check 为准。

## 3b. 渲染前检查（两套，卡片上分别标「正本 h3q」和「画布」）
### 正本 h3q（写法规则只认这一处）
卡片打开或队列一改，画布就把当前队列写进临时文件，运行 python -I "%FRAMEFLOW_H3_TOOLS%\\h3q.py" check <临时文件> --all（没指定对照表时加 --skip-table），把 ERROR（红）/ WARN（黄）/ HINT（灰，建议）按镜头挂在卡片上，标「正本 h3q」，卡片顶部写正本版本号。和单镜无关的（整集一致性、对照表、接帧成环）在顶部「整集」里。dialogue 留空、人名位置、开口 / 嘴唇闭着、点名配乐、定格、no logos、元指令、景别 / 构图 / 光线 / 表情 / 左右手、说话段字数、8 秒以上分段……都由 h3q 查，规则见正本。h3q 没跑成（没装 Python、h3q.py 不在）时卡片明说「没跑成，不能当作通过」。写完自己也跑一遍 python h3q.py check <队列.json>。
- h3q 报「dialogue 不是空」的镜头有「把台词搬进正文对白」一键按钮；报「点了背景音乐」的有「一键删掉这句」。
### 画布（h3q 查不到的）
红：
1. <Picture N> 编号要和实际提交顺序一致，最大编号不能超过实际图数。首帧 / 尾帧不占编号（正本）：有首帧（firstFrameAssetId、firstFrameFrom 或通过的关键帧）时照样从场景、角色编 <Picture 1> 起，首帧只写 the opening frame / 开场接上一镜的尾帧；提交时画布自己把编号往后挪一位给首帧，不要手动 +1，否则会换脸。
2. 时间段从 0 秒开始、首尾相接、不重叠，最后一段不超过 seconds。H3 帧数对齐后实际会略短（如 14 秒 → 13.67 秒），最后一段别卡死在整秒结尾。
3. 角色 ID 在角色库里找不到；出镜的角色没绑主外观（用户在角色库里绑）；参考图排不出来（素材 ID 不存在）。
黄：
4. 帧数对齐后时间轴被压缩，或时间轴比实际时长短 1 秒以上。
5. 对白里的名字不在这一镜的角色里。
6. 写声音（soundMode 不是 silent 时）。
7. 每个时间段都有人在动（不能只有「看着 / 停在」）。
8. 绑了外观的角色要在提示词里提到。

## 4. 卡片里的「台词」
- 每个角色后面的「台词」按钮：一行一句，保存时写进正文「对白（中文普通话，口型同步）：」那一行（一个名字一句：张三：“……” 李四：“……”），不写 dialogue。没填台词的角色什么都不加。
- 单独补台词也可以交一份 { "镜头标题": { "角色名": ["第一句", "第二句"] } }，用户在卡片里点「从 JSON 导入台词」按镜头标题和角色名写进对白行。

## 5. 先出关键帧（可选，原生产线做法）
"keyframe":{"prompt":"英文：外观、景别、构图（Flux 读不懂中文，不写否定词）","faceRoleId":"锁谁的脸（本镜 roleIds 里的角色）","faceWeight":0.85,"storyboardAssetId":"分镜图 ID（可选，锁构图）","count":3}
- 用户在卡片里出几张候选，挑一张「通过」，那张就成为这一镜的首帧（firstFrameAssetId，generationMode 自动改为 first-last），视频从它开始。
- 写了 keyframe 的镜头，prompt 里的 <Picture N> 照样不给首帧编号（和没有首帧时一样写）；用户点「通过」后提示词不用改，提交时画布自己挪编号。
- 用 firstFrameFrom 接上一镜尾帧的镜头不能写 keyframe。

## 6. 接首尾帧
"generationMode":"first-last","firstFrameFrom":{"shot":"上一镜完整 title","frame":"last"}
- 写完整 title，少用 "previous"。只接同一机位、同一景别的连续动作；特写、换高度、换人不接。
- 被接的镜头不要删；卡片会拦。

## 7. 用户会怎么改
用户可能在卡片里改参数、分段改提示词、复制一镜（「·副本」）、用尾帧接一镜（「·续」）、点「复制错误」把检查结果发给你。收到检查结果时：只改有问题的镜头，title 一字不改，其他内容原样保留，返回整份 JSON。

## 8. 本集设定（可选，正本 v2026-11-11.5 正式写法）
整集共用的风格句、各场景光线句、画面要求、各场景环境底声可以放进队列顶层 "episode"：{"style":"…","lighting":{"办公室":"…"},"frameRequirements":"…（不含「画面要求：」四个字）","ambience":{"办公室":"…"}}，镜头 prompt 里写占位 {{本集.风格}}、{{本集.光线.办公室}}、{{本集.画面要求}}、{{本集.底声.办公室}}。
- 纯文字替换：标签留在正文（画面要求：{{本集.画面要求}}、声音：{{本集.底声.办公室}}他的手…），句号由设定值自己带。用哪个场景就在占位里写场景名，不按场景图猜。
- 画布读队列时先换回原句，之后检查、完整度、画面五项、提交给模型的都是换回后的正文，和 python h3q.py expand 的结果一字不差。
- 会被拦：占位在本集设定里没有；括号写错（展开后还剩 {{ }} ｛｛ ｝｝ 或「本集.」）；episode 里有这四个以外的键；设定值空、首尾有空格、里面又有占位或 <Picture N>；场景名空、超过 20 字或有空格 . { }；占位写在 prompt 以外。
- 没有 episode 的旧队列照旧逐字复制，可以混用。用户在卡片顶部「本集设定」里改设定，用到它的镜头一起变；不要把展开后的正文抄回去替换占位。
`;
