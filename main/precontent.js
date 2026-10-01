import { lib, game } from "noname";
// 在这里引入角色包：precontent 阶段比 content 更早执行，
// 可以让角色包在「模式加载 -> loadCharacter」之前就进入 lib.imported.character
import "../character/index.js";

export function precontent(config, pack) {
	// 角色包名（character/index.js 里的 name 是 arknights）在界面上显示的文字
	lib.translate.arknights = "明日方舟";

	// ★关键一步：把角色包加入「已启用武将包」列表 lib.config.characters。
	// 游戏在模式加载时会对 lib.imported.character 里的每个包调用 loadCharacter，
	// 但 loadCharacter 发现包名不在 lib.config.characters 时会直接跳过 character 字段：
	//     case "character":
	//         if (!lib.config.characters.includes(name) && ...) break;
	// 结果是技能与翻译都注册了，武将在选将界面却完全找不到。
	// 走 package.character 形式的扩展由引擎自动完成这一步，走 precontent 注册的扩展必须自己补。
	if (!lib.config.characters.includes("arknights")) {
		lib.config.characters.push("arknights");
		game.saveConfigValue("characters");
	}

	// ★ 结城理的面具②/面具③、普瑞赛斯的武将牌② 都只是换牌用的内部武将牌，
	// 不应出现在选将界面。
	// 光靠不进 characterSort 挡不住「随机选将」，所以再用 lib.filter.characterDisabled
	// 认的钩子把它标成不可选：
	//     if (lib.characterFilter[i] && !lib.characterFilter[i](get.mode())) return true;
	// 返回 false 即「任何模式下都不可选」。各人的第一张牌不设，正常可选。
	// （lib.characterFilter 在引擎里是 library/index.js 的类字段，一定存在；
	//   这里的 ||= 只是为了让脱离引擎的静态校验/单测环境也能跑通。）
	lib.characterFilter = lib.characterFilter || {};
	for (const name of ["jycl_makoto2", "jycl_makoto3", "prss_priestess2", "dx_liang"]) {
		lib.characterFilter[name] = () => false;
	}
}
