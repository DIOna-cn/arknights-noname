const characterSort = {
	// 分组 id -> 该组里的武将，分组名在 characterSortTranslate 里翻译
	ak_wsde: ["wsde_weisidaier"],
	ak_chuxue: ["cx_chuxue"],
	ak_yao: ["yao_yao"],
	ak_logos: ["lgs_logos"],
	// 结城理：只把面具①放进选将分组；面具②/③ 是換牌用的内部武将牌，
	// 由 main/precontent.js 的 lib.characterFilter 再兜一道，确保不会被随机选到
	ak_jycl: ["jycl_makoto1"],
	// 普瑞赛斯：同理只把武将牌①放进选将分组，②由 precontent 的 characterFilter 兜底
	ak_prss: ["prss_priestess1"],
	// 瓦伦西娜：称号留空，所以分组名直接用武将名
	ak_wlnx: ["wlnx_valencia"],
	// 夕：同上，称号留空
	ak_dusk: ["dusk_xi"],
	// 蓬莱山辉夜
	ak_kaguya: ["kaguya"],
	// 安洁莉娜 / 华法琳 / 乌啾 / 煌
	ak_ajln: ["ajln_angelina"],
	ak_hfl: ["hfl_warfarin"],
	ak_wj: ["wj_wujiu"],
	ak_huang: ["huang_blaze"],
	// 好运煌：和煌是两个独立武将，各占一个分组
	ak_hlucky: ["hlucky_huang"],
	ak_dhjxk: ["dhjxk_jessica"],
	// 琪露诺
	ak_qlno: ["qlno_cirno"],
	// 均的两版是同名不同武将，各占一个分组
	ak_xjh: ["xjh_jun"],
	ak_lf: ["lf_jun"],
	// 重岳 / 颉 / 黍
	ak_zy: ["zy_chongyue"],
	ak_jie: ["jie_xie"],
	ak_shu: ["shu_shu"],
	// 塔露拉 / 年
	ak_tll: ["tll_talula"],
	ak_nian: ["nian_nian"],
	// 陈
	ak_chen: ["chen_chen"],
	// 藿藿：称号「令奉贞凶」，单独占一组
	ak_huohuo: ["hh_huohuo"],
	// 沙包：测试用的白板靶子，单独占一组（不给它称号，分组名直接用武将名）
	ak_shaba: ["shaba"],
};

const characterSortTranslate = {
	ak_wsde: "绝对主角",
	ak_chuxue: "圣女",
	ak_yao: "夏末游鳞",
	ak_logos: "女妖之主",
	ak_jycl: "月行水上",
	ak_prss: "语言学家",
	ak_wlnx: "瓦伦西娜",
	ak_dusk: "夕",
	ak_kaguya: "辉夜姬",
	ak_ajln: "酸橙的心意",
	ak_hfl: "实验狂魔",
	ak_wj: "羽隐愈疗",
	ak_huang: "好兄弟",
	// 好运煌的称号留空，分组名直接用武将名（同瓦伦西娜 / 夕）
	ak_hlucky: "好运煌",
	ak_dhjxk: "流泪猫猫头",
	ak_qlno: "湖上的冰精",
	ak_xjh: "相见欢",
	ak_lf: "律法",
	ak_zy: "登临意",
	ak_jie: "辞岁行",
	ak_shu: "怀黍离",
	ak_tll: "不死的黑蛇",
	ak_nian: "洪炉示岁",
	ak_chen: "龙门警司",
	ak_huohuo: "令奉贞凶",
	ak_shaba: "沙包",
};

export { characterSort, characterSortTranslate };
