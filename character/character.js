/**
 * 明日方舟武将包的武将表
 *
 * 常用字段：
 *   sex    性别：male / female / double
 *   group  势力：wei / shu / wu / qun / jin / key ...
 *   hp     开局体力
 *   maxHp  体力上限（不写时由 Character 构造函数兜底成 hp）
 *   hujia  开局护甲
 *   skills 技能名数组，必须能在 skill.js 里找到
 *   names  「复姓|名」写法，用于把名字拆成两行显示，如 "诸葛|亮"
 *   isUnseen 隐藏武将（不出现在选将界面）
 *
 * ★ hp / maxHp / hujia 是**三个独立字段**，分别落到 player.hp /
 *   player.maxHp / player.hujia（见 library/element/player.js 的 init）。
 *   所以「六上限两血一甲」= { hp: 2, maxHp: 6, hujia: 1 }。
 *
 * ★ img 必须**逐张显式写**，文件名再"正好"也没用 ——
 *   引擎那套「没写 img 就自动去找 extension/<扩展名>/<武将id>.jpg」的补全
 *   只对**通过 package.character 提供角色包**的扩展生效（init/loading.js 的
 *   loadExtension）；本扩展的角色包是在 main/precontent.js 里
 *   game.import("character", ...) 注册的，走 lib.imported.character →
 *   loadCharacter() 那条路，而 loadCharacter 对 character 表只做一句
 *   `lib.character[key2] = value2`，**不补 img、也不补 dieAudios**。
 *   漏写 img 的武将卡面会回落成默认剪影。
 *
 * @type { importCharacterConfig['character'] }
 */
const characters = {
	// 正式武将：三个技能互相联动（魂影铺垫 -> 余震追加伤害 -> 黎明把追加伤害扩散）
	wsde_weisidaier: {
		sex: "female",
		group: "qun",
		hp: 4,
		skills: ["wsde_yuzhen", "wsde_hunying", "wsde_liming"],
		// 显式指定插画（扩展默认只会去找 <武将id>.jpg，这里是 png）
		img: "extension/方舟/wsde_weisidaier.png",
	},
	// 正式武将：转换技在两个「距离修正」技能之间切换
	// 【圣山】（每轮加护甲、别人离你更远、手牌上限+2）和
	// 【霜涛】（你的【杀】可指定至多三名目标、别人离你更近）互斥
	cx_chuxue: {
		sex: "female",
		group: "wei",
		hp: 3,
		skills: ["cx_xuejing", "cx_qiyuan", "cx_shengshan"],
		// 开局自带【圣山】；【霜涛】是衍生技，只能由【祈愿】①获得
		img: "extension/方舟/cx_chuxue.png",
	},
	// 正式武将：围绕「浮泡」标记做文章
	// 【浮光】在回合开始给攻击范围内的角色贴标记（受伤即回血并移去），
	// 【幽萤】则在自己回合内把「移去标记」变成一次范围伤害
	yao_yao: {
		sex: "female",
		group: "qun",
		hp: 3,
		skills: ["yao_fuguang", "yao_youying"],
		img: "extension/方舟/yao_yao.png",
	},
	// 正式武将：一个技能在「距离」和「手牌」之间做交换
	// 【提喻】弃红牌把人推远并补偿他一张牌，弃黑牌把人拉近并封死他一张手牌；
	// 【殁亡】盯着全场，谁掉到 1 血、又恰好在自己攻击范围内，就再补一刀
	lgs_logos: {
		sex: "female",
		group: "qun",
		hp: 3,
		skills: ["lgs_tiyu", "lgs_mowang"],
		img: "extension/方舟/lgs_logos.png",
	},
	// ── 夕（群 / 3体力）──────────────────────────────────────────
	// 称号按作者要求留空（title.js 里写的是一个空格而不是 ""，原因见 translate.js 的注释）。
	// ★ img 必须**显式写出来**，文件名再"正好"也没用 ——
	//   引擎确实有一套「没写 img 就自动去找 extension/<扩展名>/<武将id>.jpg」的补全，
	//   但它在 init/loading.js 的 loadExtension 里，而且外面套着
	//       if (typeof extension[4].character?.character == "object" && ...)
	//   —— 也就是**只有通过 package.character 提供角色包的扩展**才吃得到。
	//   本扩展的角色包是在 main/precontent.js 里 game.import("character", ...) 注册的，
	//   走的是 lib.imported.character → loadCharacter() 那条路，而 loadCharacter
	//   对 character 表只做一句 `lib.character[key2] = value2`，
	//   **不补 img、也不补 dieAudios**。所以没写 img 的武将卡面会回落成默认剪影。
	dusk_xi: {
		sex: "female",
		group: "qun",
		hp: 3,
		skills: ["dx_moliang", "dx_danqing", "dx_xieyi"],
		// 立绘在扩展根目录，是 jpg（其余干员都是 png）
		img: "extension/方舟/dusk_xi.jpg",
	},
	// 被「墨魎」召唤出来的单位「魉」：2 体力上限、没有技能。
	// 这里只是它作为**武将牌**的定义；它在场上的特殊规则（没有装备区 / 判定区、
	// 摸牌阶段不摸牌、回合由夕操控、濒死即死）由 skill.js 里给它的那一组隐藏技能负责。
	// 和另外几张内部武将牌（结城理的面具②③、普瑞赛斯的武将牌②）一样不可选，
	// 由 main/precontent.js 的 lib.characterFilter 挡掉。
	dx_liang: {
		sex: "female",
		group: "qun",
		hp: 2,
		skills: [],
	},
	// ── 结城理 · 月行水上（三张面具）────────────────────────────
	// 三张武将牌显示名都叫「结城理」（translate 里同名），描述上都只有「面具」一个技能。
	// 只有 jycl_makoto1 能被选将：jycl_makoto2/3 会在 main/precontent.js 里
	// 通过 lib.characterFilter 标记为不可选（characterDisabled 会读它）。
	// 三张体力上限都是 1，换牌即回满，转换链见 skill.js 顶部的说明。
	jycl_makoto1: {
		sex: "male",
		group: "qun",
		hp: 1,
		skills: ["jycl_mianju_a"],
		img: "extension/方舟/jycl_makoto1.png",
	},
	jycl_makoto2: {
		sex: "male",
		group: "qun",
		hp: 1,
		skills: ["jycl_mianju_b"],
		img: "extension/方舟/jycl_makoto2.png",
	},
	jycl_makoto3: {
		sex: "male",
		group: "qun",
		hp: 1,
		skills: ["jycl_mianju_c"],
		img: "extension/方舟/jycl_makoto3.png",
	},
	// ── 普瑞赛斯 · 语言学家（两张武将牌）────────────────────────
	// 与结城理同一套骨架：两张武将牌显示名都叫「普瑞赛斯」，描述上都只有一个空白技能。
	// 只有 prss_priestess1 能被选将；prss_priestess2 会在 main/precontent.js 里
	// 通过 lib.characterFilter 标记为不可选，只能由①的觉醒技在死亡时换上来。
	// 两张体力上限都是 3，但换牌**不回满**（体力保留觉醒时 revive 出来的 1 点）。
	prss_priestess1: {
		sex: "female",
		group: "qun",
		hp: 3,
		skills: ["prss_gaixie"],
		img: "extension/方舟/prss_priestess1.png",
	},
	prss_priestess2: {
		sex: "female",
		group: "qun",
		hp: 3,
		skills: ["prss_tihuan"],
		img: "extension/方舟/prss_priestess2.png",
	},
	// ── 瓦伦西娜（蜀 / 4体力）────────────────────────────────────
	// 称号按作者要求留空（title.js 里写的是一个空格而不是 ""，原因见 translate.js 的注释）。
	// 不写 img：素材目录里没有这个武将的立绘，游戏会自动回落到
	// image/character/default_silhouette_female.jpg。
	wlnx_valencia: {
		sex: "female",
		group: "shu",
		hp: 4,
		skills: ["wlnx_nuqiang", "wlnx_zhenchan", "wlnx_chuzhi"],
	},
	// ── 蓬莱山辉夜 · 辉夜姬（群 / 3体力）────────────────────────
	// ★ 同夕：img 必须显式写（理由见上面 dusk_xi 的注释）。
	// 她的技能围绕十张「神宝」衍生装备牌展开，那十张牌定义在 character/card.js。
	//
	// 初始只有【初月】和【难题】两个技能；其余七个（待宵 / 永远 / 朝靄 / 须臾 /
	// 拂晓 / 永夜归反 -破晓明星- / 永夜归反 -世间开明-）都在觉醒链上，
	// 靠【初月】起头的五个觉醒技在游戏里一步步 addSkill 长出来，
	// 所以**不要**写进下面的 skills 数组。
	kaguya: {
		sex: "female",
		group: "qun",
		hp: 3,
		skills: ["kgy_chuyue", "kgy_nanti"],
		// 立绘在扩展根目录，是 jpg
		img: "extension/方舟/kaguya.jpg",
	},
	// ── 安洁莉娜 · 酸橙的心意（蜀 / 4体力）──────────────────────
	ajln_angelina: {
		sex: "female",
		group: "shu",
		hp: 4,
		skills: ["ajln_zhongli"],
		img: "extension/方舟/ajln_angelina.png",
	},
	// ── 华法琳 · 实验狂魔（蜀 / 六上限 两血 一甲）────────────────
	// 「六上限两血一甲」= hp 2 / maxHp 6 / hujia 1，三个字段各管一件事
	// （字段含义见文件顶部的说明）。
	hfl_warfarin: {
		sex: "female",
		group: "shu",
		hp: 2,
		maxHp: 6,
		hujia: 1,
		skills: ["hfl_xuejiang", "hfl_shiyan"],
		img: "extension/方舟/hfl_warfarin.png",
	},
	// ── 乌啾 · 羽隐愈疗（魏 / 3体力）────────────────────────────
	// 【捉迷藏】和【保身】是武将技能；中间那段没写技能名的效果由【迷彩】承载
	// （名字是这里起的，理由见 skill.js 的注释）。
	wj_wujiu: {
		sex: "female",
		group: "wei",
		hp: 3,
		skills: ["wj_zhuomicang", "wj_micai", "wj_baoshen"],
		img: "extension/方舟/wj_wujiu.png",
	},
	// ── 煌 · 好兄弟（蜀 / 4体力）────────────────────────────────
	// 【沸腾】【爆裂】不写进 skills：它们是【过载】在体力低于 3 / 2 时
	// 临时 addSkill 上来的，写在这里会变成开局就一直拥有。
	huang_blaze: {
		sex: "female",
		group: "shu",
		hp: 4,
		skills: ["huang_lianju", "huang_chuchan", "huang_guozai"],
		img: "extension/方舟/huang_blaze.png",
	},
	// ── 好运煌（蜀 / 4体力）──────────────────────────────────────
	// 与煌是**两个独立的武将**：技能表、storage 键、语音文件都带自己的
	// hlucky 前缀，同场也不会互相串账（九个技能由 skill.js 的 huangSkillSet
	// 按前缀生成两份，实现共用一份）。
	// 差别只在【链锯】：好运煌每次抽牌前先把牌堆顶铺成两张「视为红色」的牌。
	// 【除颤】【过载】【沸腾】【爆裂】与煌一字不差。
	hlucky_huang: {
		sex: "female",
		group: "shu",
		hp: 4,
		skills: ["hlucky_lianju", "hlucky_chuchan", "hlucky_guozai"],
		img: "extension/方舟/hlucky_huang.png",
	},
	// ── 涤火杰西卡 · 流泪猫猫头（群 / 四上限 三血 一甲 / 主公）────
	// 七个技能，其中盾牌/手铳/整备是持恒技（persevereSkill），
	// 黑钢是主公技（zhuSkill，只在主公局生效），家族是使命技（dutySkill）。
	// 主公身份本身由对局模式决定，武将表里不写额外的标记。
	//
	// 「四上限三血一甲」同样是三个独立字段：hp 3 / maxHp 4 / hujia 1
	// （字段含义见文件顶部，写法与华法琳的「六上限两血一甲」一致）。
	// 开局那一点甲正好喂给【盾牌】——「每次只能失去一点」与「失去护甲时三选一」
	// 都要先有甲才谈得上。
	dhjxk_jessica: {
		sex: "female",
		group: "qun",
		hp: 3,
		maxHp: 4,
		hujia: 1,
		skills: ["dhjxk_dunpai", "dhjxk_shouchong", "dhjxk_buchong", "dhjxk_jianpao", "dhjxk_zhengbei", "dhjxk_heigang", "dhjxk_jiazu"],
		img: "extension/方舟/dhjxk_jessica.png",
	},
	// ── 琪露诺 · 湖上的冰精（魏 / 3体力）──────────────────────────
	// 【智慧】盯着全场的「失去牌」：在自己回合内看别人，回合外看自己。
	// 【冰精】拆成三块 —— 主技能是「三张牌当冰【杀】使用或打出」的视为技，
	//   · qlno_bingjing_ice  把「你造成的伤害」改写成冰属性；
	//   · qlno_bingjing_sha  视为技的「无距离 / 无次数」两条加成。
	// 两个子技能都用 charlotte 藏起来，技能栏里只留一个【冰精】。
	//
	// ★「冰属性伤害可以防止、改为弃置目标两张牌」**不需要写** ——
	//   引擎的全局规则技 icesha_skill（由【杀】卡上的 global 字段提升而来）
	//   已经在管所有冰属性伤害了，自己再接一份会同一件事问两遍（实机踩过）。
	//   详见 skill.js 里 qlno_bingjing_ice 的注释。
	//
	// ★ 立绘素材的真名是「湖上的冰精.琪露诺-原画.png」，但**它其实是 JPEG**
	//   （文件头是 FF D8 FF E0），扩展名写错了。所以这里按实际格式存成 .jpg，
	//   与 dusk_xi / kaguya 一样走 jpg 分支。
	qlno_cirno: {
		sex: "female",
		group: "wei",
		hp: 3,
		skills: ["qlno_zhihui", "qlno_bingjing"],
		img: "extension/方舟/qlno_cirno.jpg",
	},
	// ── 均 · 相见欢（魏 / 3体力）──────────────────────────────────
	// 描述文件里没写势力（作者已确认取魏）。
	// 【音律】给出去的「签」是一张**牌标记**：在别人手里时回合外不能用，
	// 被【掷签】收上武将牌之后又变成一枚可以弃置的标记。
	// 【断案】是【五阶】觉醒后长出来的衍生技，所以不写进下面的 skills。
	xjh_jun: {
		sex: "female",
		group: "wei",
		hp: 3,
		skills: ["xjh_yinlv", "xjh_zhiqian", "xjh_wujie", "xjh_jingtang"],
		// ★ 素材目录里的立绘真名是「立绘<U+200B>.jpg」——「绘」和「.」之间夹了一个
		//   零宽空格（U+200B）。那个字符不能带进扩展（引擎按 URL 取图，零宽字符
		//   在部分环境下会被吃掉），所以搬运时按扩展惯例改名成 <武将id>.jpg。
		img: "extension/方舟/xjh_jun.jpg",
	},
	// ── 均 · 律法（魏 / 3体力）────────────────────────────────────
	// 与上面「相见欢」那个均是**两个独立武将**（作者确认）：同名不同称号，
	// 技能名与 storage 键各带自己的前缀（xjh_ / lf_），同场也不会互相串账。
	// 取材时两张立绘也是分开的。
	lf_jun: {
		sex: "female",
		group: "wei",
		hp: 3,
		skills: ["lf_dingfa", "lf_yinyue"],
		img: "extension/方舟/lf_jun.png",
	},
	// ── 重岳 · 登临意（魏 / 3体力）────────────────────────────────
	// 开局只有【戍边】一个技能；【镇乾】【定坤】【为家】都在它的觉醒链上，
	// 由 zy_shubian_charge 在累计打出 1/2/3 张【杀】时依次 addSkill 上来，
	// 写进 skills 数组会变成开局就一直拥有。
	zy_chongyue: {
		sex: "male",
		group: "wei",
		hp: 3,
		skills: ["zy_shubian"],
		// 立绘是后补的（素材真名是「立绘<U+200B>.png」，夹着零宽空格）
		img: "extension/方舟/zy_chongyue.png",
	},
	// ── 颉 · 辞岁行（魏 / 3体力）──────────────────────────────────
	// 【保身】是【明哲】使命成功后才给的衍生技，不写进 skills。
	// 【诀别】作者已同意先跳过：无名杀的濒死结算是一次性的
	// （求桃走完就结束），「维持濒死状态直至你的下个回合结束」做不到，
	// 与其做个假的，不如先留着。
	jie_xie: {
		sex: "female",
		group: "wei",
		hp: 3,
		skills: ["jie_zhengshi", "jie_shudao", "jie_mingzhe"],
		// 立绘同样是 jpg（其余干员都是 png）
		img: "extension/方舟/jie_xie.jpg",
	},
	// ── 黍 · 怀黍离（魏 / 3体力）──────────────────────────────────
	// 描述文件写的是「黍 三血 魏 称号：怀黍离」，没写性别，按作者确认为女。
	shu_shu: {
		sex: "female",
		group: "wei",
		hp: 3,
		skills: ["shu_chunzhong", "shu_qiushou", "shu_kurong"],
		// 立绘同样是后补的（素材真名也夹着零宽空格）
		img: "extension/方舟/shu_shu.png",
	},
	// ── 塔露拉 · 不死的黑蛇（群 / 3体力）────────────────────────────
	// 【燎原】【安魂】都会在【黑蛇】觉醒后整体翻转，所以武将表里只挂这三个
	// 主技能；觉醒后长出来的 tll_heishe_recover 由技能自己 addSkill 上去。
	tll_talula: {
		sex: "female",
		group: "qun",
		hp: 3,
		skills: ["tll_liaoyuan", "tll_anhun", "tll_heishe"],
		// 素材给的是「觉醒前立绘.png」与「觉醒后立绘.png」两张，这里写觉醒前
		// 的那张；觉醒后由 tll_heishe 直接改 DOM 换成 tll_talula_awake.png
		img: "extension/方舟/tll_talula.png",
	},
	// ── 年 · 洪炉示岁（魏 / 4体力）──────────────────────────────────
	nian_nian: {
		sex: "female",
		group: "wei",
		hp: 4,
		skills: ["nian_suizhu", "nian_honglu", "nian_duanqi"],
		// 素材真名是「立绘<U+200B>.png」，「绘」后面夹了一个零宽空格（U+200B）
		img: "extension/方舟/nian_nian.png",
	},
	// ── 陈 · 龙门警司（魏 / 4体力）──────────────────────────────────
	// 语音 6 条（作战中1~4 / 部署1~2），源自 素材\_待实现\陈；
	// 立绘原文件名夹着零宽空格，搬运时已按武将 id 改名。
	chen_chen: {
		sex: "female",
		group: "wei",
		hp: 4,
		skills: ["chen_jueying", "chen_badao", "chen_xingzhao"],
		img: "extension/方舟/chen_chen.png",
	},
	// ── 藿藿 · 令奉贞凶（魏 / 3体力）────────────────────────────────
	// 素材目录原名「霍霍」，按作者要求统一改用星铁官方译名「藿藿」
	//（素材文件夹与描述.txt 里的名字也一并改掉了）。
	// 三个技能共用一套「伤害账本」：【护命】是真挨打时的补偿，
	// 【尾巴】把「造成过伤害」记到别人头上，【凭依】开局把尾巴寄在一个人身上；
	// 后两个用的都是引擎的 unreal 伤害（记账但不掉血），详见 skill.js 顶部。
	hh_huohuo: {
		sex: "female",
		group: "wei",
		hp: 3,
		skills: ["hh_huming", "hh_weiba", "hh_pingyi"],
		// 立绘在扩展根目录，是 jpg（素材真名就叫「立绘.jpg」）
		img: "extension/方舟/hh_huohuo.jpg",
	},
	// ── 沙包（群 / 1000体力）────────────────────────────────────────
	// 作者的练手靶子：白板（skills 留空）、没有立绘（卡面回落成默认剪影，
	// 所以这里**故意不写 img**，写一个不存在的路径反而会加载失败）。
	// 1000 点体力专门用来挨打试技能 —— hp 一个字段就够，
	// maxHp 不写时由 Character 构造函数兜底成 hp（同其余武将）。
	shaba: {
		sex: "male",
		group: "qun",
		hp: 1000,
		skills: [],
	},
};

export default characters;
