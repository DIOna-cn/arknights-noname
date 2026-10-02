const characterTitles = {
	wsde_weisidaier: "绝对主角",
	cx_chuxue: "圣女",
	yao_yao: "夏末游鳞",
	lgs_logos: "女妖之主",
	// 三张面具共用同一个称号（虽然只有 jycl_makoto1 会被显示出来）
	jycl_makoto1: "月行水上",
	jycl_makoto2: "月行水上",
	jycl_makoto3: "月行水上",
	// 普瑞赛斯的两张武将牌共用同一个称号（虽然只有 prss_priestess1 会被显示出来）
	prss_priestess1: "语言学家",
	prss_priestess2: "语言学家",
	// 瓦伦西娜：作者要求称号留空。
	// 这里同样不能写 ""，理由与 translate.js 里普瑞赛斯的技能名一致 ——
	// get.translation 用真值判断，空字符串会被跳过、最终把内部 id 显示出来。
	// 填一个空格即可渲染成空白。
	wlnx_valencia: " ",
	// 夕：同样要求称号留空，理由同上
	dusk_xi: " ",
	// 蓬莱山辉夜
	kaguya: "辉夜姬",
	// 安洁莉娜 / 华法琳 / 乌啾 / 煌
	ajln_angelina: "酸橙的心意",
	hfl_warfarin: "实验狂魔",
	wj_wujiu: "羽隐愈疗",
	huang_blaze: "好兄弟",
	// 好运煌：作者没有给称号，按瓦伦西娜 / 夕的写法留空
	// （同样不能写 ""，填一个空格才渲染成空白，理由见上面 wlnx_valencia）。
	hlucky_huang: " ",
	// 涤火杰西卡：称号来自作者描述文件的表头
	dhjxk_jessica: "流泪猫猫头",
	// 琪露诺：称号来自作者描述文件的表头
	qlno_cirno: "湖上的冰精",
	// 均的两版：同名不同称号，靠称号 + 分组区分
	xjh_jun: "相见欢",
	lf_jun: "律法",
	// 重岳 / 颉 / 黍
	zy_chongyue: "登临意",
	jie_xie: "辞岁行",
	shu_shu: "怀黍离",
	// 塔露拉 / 年：称号来自各自描述文件的表头
	tll_talula: "不死的黑蛇",
	nian_nian: "洪炉示岁",
	// 藿藿：称号来自作者描述文件的表头
	hh_huohuo: "令奉贞凶",
	// 芙兰朵露：称号来自素材的 武将.json（title 字段）
	fld_flandre: "恶魔之妹",
};

export default characterTitles;
