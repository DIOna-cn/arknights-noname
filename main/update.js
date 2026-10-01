import { game, lib } from "noname";

// ════════════════════════════════════════════════════════════════════
//  方舟 · 在线更新
// ════════════════════════════════════════════════════════════════════
//
// 把仓库里的一份 update.json 当作「真相」，逐文件比对本地，只下载变化过的，
// 校验通过后备份旧文件再覆盖。全部走引擎自带的文件 API（game.download /
// game.readFile / game.writeFile），不碰 lib.node，也不依赖 fetch 的跨域许可。
//
// 为什么能用 game.download：
//   Electron 下它是 `https.get` + `fs.createWriteStream`（init/node.js），
//   根目录是 __dirname = resources/app，所以传 "extension/方舟/xxx" 正好落位；
//   而它跑在 node 层，**不受页面同源策略约束**（file:// 页面 fetch 跨域要靠
//   服务端给 CORS 头，这里完全不需要）。
//
// 为什么下载源是这几家：
//   Gitee 的 raw 会 302 到 raw.giteeusercontent.com，那个域在本地网络是 TLS 层
//   直接被 reset 的，等于下不动，所以只认 GitHub。GitHub 直连实测 4~18s，
//   而 ghproxy.net / gh-proxy.com / ghfast.top 都是 200 + 零重定向 + 1~2s，
//   并且拿回来的二进制和直连 MD5 完全一致。jsDelivr 反而对本仓库 301 回源，
//   不能当主源，索性不用。
//
// 为什么必须自己实现 MD5：
//   game.download 只看「流有没有出错」，**不看 HTTP 状态码** —— 服务器返 404
//   时它会把错误页当正文写进目标文件。所以每次下载都必须拿回来重新算哈希，
//   对不上就换下一个源。而引擎自带的 hex_md5（noname/library/crypt/md5.js）
//   内部把输入当字符串做 UTF-8 编码，喂二进制会破坏字节，且它没挂在 lib 上、
//   扩展也 import 不到（importmap 里只有 "noname" 一个映射），只能自己写一份。
//
// 更新是「先全部下载到临时目录并校验，全部通过后才开始覆盖」，
// 所以中途断网不会留下半新半旧的状态。

// ── 仓库位置 ────────────────────────────────────────────────────────
// 形如 "用户名/仓库名@分支"。可以在「扩展 → 方舟 → 在线更新」里改，
// 改了之后所有检查都走新地址（换源、换分支、别人 fork 一份自己发布都靠它）。
const DEFAULT_REPO = "__GITHUB_USER__/arknights-noname@main";
export { DEFAULT_REPO };

/** 清单文件名（放在仓库根目录） */
const MANIFEST = "update.json";

// 下载源前缀，按顺序回退。空串 = 直连 raw.githubusercontent.com（最慢但最权威）。
const MIRROR_PREFIX = ["https://ghproxy.net/", "https://gh-proxy.com/", "https://ghfast.top/", ""];

/** 单个文件的下载超时（毫秒）。首次全量时大立绘可能要十几秒，给足 */
const TIMEOUT = 120000;
/** 同时下载几个文件。引擎每次下载都会写两遍 brokenFile 配置，并发太高反而卡 */
const CONCURRENCY = 4;

// ── 路径 ────────────────────────────────────────────────────────────
/**
 * 本扩展相对 resources/app 的目录，带尾斜杠，例如 "extension/方舟/"。
 *
 * 不能写死 "extension/方舟"：解压时被改名、或者外面多套一层文件夹，写死的路径
 * 就指到别处去了（extension.js 里读 info.json 也踩过这个坑，那边同样是从
 * import.meta.url 反推）。这里用 `/extension/` 作为锚点取最后一段，
 * 因为 update.js 自己就住在 <app>/extension/<目录名>/main/ 里面。
 */
function extensionDir() {
	let pathname;
	try {
		pathname = decodeURIComponent(new URL("../", import.meta.url).pathname);
	} catch (e) {
		pathname = "";
	}
	const marker = "/extension/";
	const index = pathname.lastIndexOf(marker);
	if (index >= 0) {
		return pathname.slice(index + 1);
	}
	// 兜底：拿不到就按官方目录名拼，至少不让整个扩展崩掉
	return "extension/方舟/";
}

export const EXT_DIR = extensionDir();
/** 下载中转站。名字以点开头，引擎的 getFileList 会跳过它，不会被当成扩展资源 */
const TMP_DIR = `${EXT_DIR}.update-tmp/`;
/** 覆盖前把旧文件挪到这里，只保留最近一次 */
const BACKUP_DIR = `${EXT_DIR}_backup/`;

// ── MD5（直接吃字节，RFC 1321）──────────────────────────────────────
const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_K = (() => {
	const table = new Int32Array(64);
	for (let i = 0; i < 64; i++) {
		table[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
	}
	return table;
})();

/**
 * @param {Uint8Array|ArrayBuffer|Buffer} input
 * @returns {string} 32 位小写十六进制
 */
export function md5(input) {
	const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
	const length = u8.length;
	// 补位到 64 字节的整数倍：先补 0x80，再补 0，最后 8 字节放原始 bit 长度（小端）
	const total = (((length + 8) >> 6) + 1) << 6;
	const buffer = new Uint8Array(total);
	buffer.set(u8);
	buffer[length] = 0x80;
	const view = new DataView(buffer.buffer);
	const bitLength = length * 8;
	view.setUint32(total - 8, bitLength >>> 0, true);
	view.setUint32(total - 4, Math.floor(bitLength / 4294967296), true);

	let a0 = 0x67452301;
	let b0 = 0xefcdab89 | 0;
	let c0 = 0x98badcfe | 0;
	let d0 = 0x10325476;
	const M = new Int32Array(16);

	for (let offset = 0; offset < total; offset += 64) {
		for (let i = 0; i < 16; i++) {
			M[i] = view.getInt32(offset + i * 4, true);
		}
		let a = a0;
		let b = b0;
		let c = c0;
		let d = d0;
		for (let i = 0; i < 64; i++) {
			let f, g;
			if (i < 16) {
				f = (b & c) | (~b & d);
				g = i;
			} else if (i < 32) {
				f = (d & b) | (~d & c);
				g = (5 * i + 1) % 16;
			} else if (i < 48) {
				f = b ^ c ^ d;
				g = (3 * i + 5) % 16;
			} else {
				f = c ^ (b | ~d);
				g = (7 * i) % 16;
			}
			const sum = (a + f + MD5_K[i] + M[g]) | 0;
			const shift = MD5_S[(i >> 4) * 4 + (i % 4)];
			const rotated = (sum << shift) | (sum >>> (32 - shift));
			a = d;
			d = c;
			c = b;
			b = (b + rotated) | 0;
		}
		a0 = (a0 + a) | 0;
		b0 = (b0 + b) | 0;
		c0 = (c0 + c) | 0;
		d0 = (d0 + d) | 0;
	}

	const out = new Uint8Array(16);
	const outView = new DataView(out.buffer);
	outView.setInt32(0, a0, true);
	outView.setInt32(4, b0, true);
	outView.setInt32(8, c0, true);
	outView.setInt32(12, d0, true);
	let hex = "";
	for (let i = 0; i < 16; i++) {
		hex += out[i].toString(16).padStart(2, "0");
	}
	return hex;
}

// ── 引擎文件 API 的 Promise 包装 ────────────────────────────────────
/** 统一成 "extension/方舟/xxx" 这种正斜杠形式，避免出现 "//" 或反斜杠 */
function joinPath(dir, relative) {
	return (dir + relative).replace(/\/{2,}/g, "/");
}

function readAsync(path) {
	return new Promise(resolve => {
		try {
			game.readFile(path, data => resolve(data || null), () => resolve(null));
		} catch (e) {
			resolve(null);
		}
	});
}

function writeAsync(data, dir, name) {
	return new Promise(resolve => {
		try {
			game.writeFile(data, dir, name, error => resolve(!error));
		} catch (e) {
			resolve(false);
		}
	});
}

function readTextAsync(path) {
	return new Promise(resolve => {
		try {
			game.readFileAsText(path, text => resolve(typeof text == "string" ? text : null), () => resolve(null));
		} catch (e) {
			resolve(null);
		}
	});
}

function removeAsync(path) {
	return new Promise(resolve => {
		try {
			game.removeFile(path, () => resolve(true));
		} catch (e) {
			resolve(false);
		}
	});
}

function removeDirAsync(dir) {
	return new Promise(resolve => {
		try {
			game.removeDir(dir, () => resolve(true), () => resolve(false));
		} catch (e) {
			resolve(false);
		}
	});
}

/**
 * 下载到指定路径。
 *
 * ⚠ game.download 的 onerror 只在「流出错」时触发，HTTP 404/403 会走 onsuccess
 *   并把错误页写下来。所以这里只把它当作「拉到了一个文件」，
 *   内容对不对一律由调用方的哈希校验说了算。
 */
function downloadAsync(url, target) {
	return new Promise(resolve => {
		let settled = false;
		const finish = value => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
		const timer = setTimeout(() => finish(false), TIMEOUT);
		try {
			game.download(
				url,
				target,
				() => {
					clearTimeout(timer);
					finish(true);
				},
				() => {
					clearTimeout(timer);
					finish(false);
				}
			);
		} catch (e) {
			clearTimeout(timer);
			finish(false);
		}
	});
}

// ── 仓库地址与下载源 ────────────────────────────────────────────────
export function getRepoSpec() {
	const saved = lib.config["extension_方舟_update_repo"];
	if (typeof saved == "string" && saved.trim()) {
		return saved.trim();
	}
	return DEFAULT_REPO;
}

/** "user/repo@branch" → { owner, repo, branch } */
export function parseRepoSpec(spec) {
	const at = spec.lastIndexOf("@");
	const path = at >= 0 ? spec.slice(0, at) : spec;
	const branch = at >= 0 ? spec.slice(at + 1) : "main";
	const slash = path.indexOf("/");
	if (slash < 0) {
		return null;
	}
	const owner = path.slice(0, slash).trim();
	const repo = path.slice(slash + 1).trim();
	if (!owner || !repo) {
		return null;
	}
	return { owner, repo, branch: branch.trim() || "main" };
}

/** 按回退顺序给出所有可用的下载前缀（每个都以 / 结尾，后面直接接仓库内相对路径） */
export function buildSources() {
	const spec = parseRepoSpec(getRepoSpec());
	if (!spec) {
		return [];
	}
	const raw = `https://raw.githubusercontent.com/${spec.owner}/${spec.repo}/${spec.branch}/`;
	return MIRROR_PREFIX.map(prefix => (prefix ? prefix + raw : raw));
}

/** 依次换源下载同一个文件，任何一个源拿到的内容哈希对得上就成功 */
async function downloadVerified(relative, target, expected, onAttempt) {
	const sources = buildSources();
	if (!sources.length) {
		return { ok: false, reason: "仓库地址没填" };
	}
	let lastReason = "所有下载源都失败了";
	for (const base of sources) {
		if (onAttempt) {
			onAttempt(base);
		}
		if (!(await downloadAsync(base + encodeURI(relative), target))) {
			lastReason = `${new URL(base).host} 连接失败`;
			continue;
		}
		const data = await readAsync(target);
		if (!data) {
			lastReason = `${new URL(base).host} 拿不到文件`;
			continue;
		}
		if (typeof expected.size == "number" && data.length !== expected.size) {
			lastReason = `${new URL(base).host} 长度不符（${data.length} ≠ ${expected.size}）`;
			await removeAsync(target);
			continue;
		}
		if (expected.md5 && md5(data) !== expected.md5) {
			lastReason = `${new URL(base).host} 内容校验失败`;
			await removeAsync(target);
			continue;
		}
		return { ok: true, data };
	}
	return { ok: false, reason: lastReason };
}

// ── 版本记录 ────────────────────────────────────────────────────────
const APPLIED_KEY = "extension_方舟_update_applied";

export function getAppliedVersion() {
	try {
		return localStorage.getItem(APPLIED_KEY) || "";
	} catch (e) {
		return "";
	}
}

function setAppliedVersion(version) {
	try {
		localStorage.setItem(APPLIED_KEY, version || "");
	} catch (e) {
		/* 隐私模式下写不进去也无所谓，下次会重算一遍哈希 */
	}
}

/** 本地 info.json 里写的版本号（也就是界面「扩展」列表里显示的那个） */
export async function getLocalVersion() {
	const text = await readTextAsync(`${EXT_DIR}info.json`);
	if (!text) {
		return "";
	}
	try {
		return JSON.parse(text).version || "";
	} catch (e) {
		return "";
	}
}

// ── 进度浮层 ────────────────────────────────────────────────────────
/** 极简浮层：不依赖引擎 UI 内部结构，更新完页面就要重载了，不值得做得更花 */
function createProgressPanel(title) {
	const panel = document.createElement("div");
	panel.style.cssText = [
		"position:fixed",
		"left:50%",
		"top:50%",
		"transform:translate(-50%,-50%)",
		"z-index:10000",
		"min-width:320px",
		"max-width:70vw",
		"padding:18px 22px",
		"border-radius:10px",
		"background:rgba(20,20,24,0.92)",
		"color:#eee",
		"font-size:15px",
		"line-height:1.7",
		"box-shadow:0 8px 30px rgba(0,0,0,0.6)",
		"text-align:center",
		"user-select:none",
	].join(";");
	const head = document.createElement("div");
	head.textContent = title;
	head.style.cssText = "font-weight:bold;margin-bottom:8px;color:#7ec8ff";
	const detail = document.createElement("div");
	detail.style.cssText = "font-size:13px;color:#bbb;word-break:break-all;min-height:1.5em";
	const bar = document.createElement("div");
	bar.style.cssText = "margin-top:10px;height:6px;border-radius:3px;background:#3a3a44;overflow:hidden";
	const fill = document.createElement("div");
	fill.style.cssText = "height:100%;width:0%;background:#7ec8ff;transition:width .15s";
	bar.appendChild(fill);
	panel.appendChild(head);
	panel.appendChild(detail);
	panel.appendChild(bar);
	document.body.appendChild(panel);

	let lastText = "";
	let lastPercent = -1;
	return {
		update(done, total, text) {
			const percent = total ? Math.round((done / total) * 100) : 0;
			if (text !== lastText) {
				detail.textContent = text || "";
				lastText = text;
			}
			if (percent !== lastPercent) {
				fill.style.width = `${percent}%`;
				lastPercent = percent;
			}
			head.textContent = `${title}（${done}/${total}）`;
		},
		setText(text) {
			detail.textContent = text;
			lastText = text;
		},
		close() {
			panel.remove();
		},
	};
}

// ── 主流程 ──────────────────────────────────────────────────────────
let busy = false;

/**
 * 拉远程清单并和本地比对。
 *
 * @param {{force?: boolean}} [options] force = 忽略「上次更新过的版本号」，逐文件重算哈希
 * @returns {Promise<null | {
 *   manifest: any, localVersion: string, remoteVersion: string,
 *   changed: string[], missing: string[], total: number, bytes: number,
 *   upToDate: boolean
 * }>} 失败时弹窗提示并返回 null
 */
export async function checkUpdates(options = {}) {
	const spec = parseRepoSpec(getRepoSpec());
	if (!spec) {
		alert("更新源地址没填对。\n请在「扩展 → 方舟 → 在线更新」里按 `用户名/仓库名@分支` 的格式填写。");
		return null;
	}

	const panel = createProgressPanel("检查更新");
	panel.setText("正在读取清单…");
	let manifest = null;
	let lastReason = "";
	try {
		const result = await downloadVerified(
			MANIFEST,
			joinPath(TMP_DIR, MANIFEST),
			null, // 清单本身没有哈希可校，靠下面的 JSON.parse 兜底
			base => {
				panel.setText(`正在读取清单…\n${new URL(base).host}`);
			}
		);
		if (!result.ok) {
			lastReason = result.reason;
		} else {
			try {
				manifest = JSON.parse(new TextDecoder("utf-8").decode(result.data));
			} catch (e) {
				lastReason = "清单不是合法的 JSON";
			}
		}
	} catch (e) {
		lastReason = String((e && e.message) || e);
	}

	if (!manifest || !manifest.files) {
		panel.close();
		alert(
			`读取更新清单失败。\n\n仓库：${spec.owner}/${spec.repo}@${spec.branch}\n` +
				`原因：${lastReason || "未知"}\n\n` +
				"可能是网络不通、仓库还没发布，或者清单路径不对。"
		);
		return null;
	}

	const localVersion = await getLocalVersion();
	const remoteVersion = String(manifest.version || "");
	const upToDate =
		!options.force && remoteVersion && remoteVersion === localVersion && remoteVersion === getAppliedVersion();

	if (upToDate) {
		panel.close();
		return {
			manifest,
			localVersion,
			remoteVersion,
			changed: [],
			missing: [],
			total: Object.keys(manifest.files).length,
			bytes: 0,
			upToDate: true,
		};
	}

	panel.update(0, 0, "正在比对本地文件…");
	const changed = [];
	const missing = [];
	let bytes = 0;
	const entries = Object.entries(manifest.files);
	let scanned = 0;
	for (const [relative, expected] of entries) {
		scanned++;
		if (scanned % 5 === 0 || scanned === entries.length) {
			panel.update(scanned, entries.length, relative);
		}
		const data = await readAsync(joinPath(EXT_DIR, relative));
		if (!data) {
			missing.push(relative);
			bytes += expected.size || 0;
			continue;
		}
		if (typeof expected.size == "number" && data.length !== expected.size) {
			changed.push(relative);
			bytes += expected.size || 0;
			continue;
		}
		// 长度一样才值得算哈希：绝大多数没动过的文件到这里就结束了
		if (expected.md5 && md5(data) !== expected.md5) {
			changed.push(relative);
			bytes += expected.size || 0;
		}
	}

	panel.close();
	return {
		manifest,
		localVersion,
		remoteVersion,
		changed,
		missing,
		total: entries.length,
		bytes,
		upToDate: changed.length === 0 && missing.length === 0,
	};
}

/**
 * 执行更新：下载 → 校验 → 备份 → 覆盖。
 *
 * 全部文件先在临时目录里下完并逐个校验，之后才开始动正式文件，
 * 所以中途失败最多留下一堆临时文件，不会把扩展改成半新半旧。
 */
export async function runUpdate() {
	if (busy) {
		return false;
	}
	busy = true;
	try {
		const report = await checkUpdates({ force: true });
		if (!report) {
			return false;
		}
		if (!report.upToDate) {
			const targets = report.changed.concat(report.missing);
			const shown = targets.slice(0, 18);
			const more = targets.length - shown.length;
			const lines = [
				`发现新版本：${report.remoteVersion || "未知"}（本地 ${report.localVersion || "未知"}）`,
				`需要更新 ${targets.length} 个文件，约 ${formatBytes(report.bytes)}。`,
				"",
				...shown.map(name => `· ${name}`),
			];
			if (more > 0) {
				lines.push(`…… 另有 ${more} 个文件`);
			}
			lines.push("", "更新完成后会刷新游戏界面，请先结束当前对局再继续。", "现在开始更新吗？");
			if (!confirm(lines.join("\n"))) {
				return false;
			}
		} else {
			return true;
		}

		const manifest = report.manifest;
		const targets = report.changed.concat(report.missing);
		const panel = createProgressPanel("正在更新");
		panel.update(0, targets.length, "准备中…");

		// ① 先把旧临时目录清掉，避免上一轮的残file被当成下载成功
		await removeDirAsync(TMP_DIR.replace(/\/$/, ""));

		// ② 全部下到临时目录并校验
		let done = 0;
		let failed = [];
		const queue = targets.slice();
		const worker = async () => {
			while (queue.length) {
				const relative = queue.shift();
				const expected = manifest.files[relative] || {};
				const result = await downloadVerified(relative, joinPath(TMP_DIR, relative), expected);
				done++;
				if (!result.ok) {
					failed.push(`${relative}（${result.reason}）`);
				}
				panel.update(done, targets.length, relative);
			}
		};
		await Promise.all(
			Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker())
		);

		if (failed.length) {
			panel.close();
			await removeDirAsync(TMP_DIR.replace(/\/$/, ""));
			alert(
				`有 ${failed.length} 个文件下载失败，本次更新已取消（本地文件没有被改动）。\n\n` +
					failed.slice(0, 8).join("\n") +
					(failed.length > 8 ? `\n…… 另有 ${failed.length - 8} 个` : "") +
					"\n\n请检查网络后重试；如果一直失败，可能是更新源被暂时墙了。"
			);
			return false;
		}

		// ③ 备份旧文件。只留最近一次 —— 备份目录整个换掉，避免无限膨胀
		panel.setText("正在备份旧文件…");
		const stamp = new Date()
			.toISOString()
			.replace(/[-:]/g, "")
			.replace("T", "-")
			.slice(0, 15);
		await removeDirAsync(BACKUP_DIR.replace(/\/$/, ""));
		const backupRoot = `${BACKUP_DIR}${stamp}/`;
		let backedUp = 0;
		for (const relative of targets) {
			const old = await readAsync(joinPath(EXT_DIR, relative));
			if (!old) {
				continue;
			}
			const slash = relative.lastIndexOf("/");
			const dir = slash >= 0 ? relative.slice(0, slash) : "";
			const name = slash >= 0 ? relative.slice(slash + 1) : relative;
			if (await writeAsync(old, joinPath(backupRoot, dir), name)) {
				backedUp++;
			}
		}

		// ④ 覆盖。临时文件读出来写回正式位置，写完删掉中转文件
		panel.setText("正在写入…");
		let written = 0;
		const writeFailed = [];
		for (const relative of targets) {
			const tmpPath = joinPath(TMP_DIR, relative);
			const data = await readAsync(tmpPath);
			if (!data) {
				writeFailed.push(relative);
				continue;
			}
			const slash = relative.lastIndexOf("/");
			const dir = slash >= 0 ? EXT_DIR + relative.slice(0, slash) : EXT_DIR.replace(/\/$/, "");
			const name = slash >= 0 ? relative.slice(slash + 1) : relative;
			if (await writeAsync(data, dir, name)) {
				written++;
			} else {
				writeFailed.push(relative);
			}
			await removeAsync(tmpPath);
			panel.update(written, targets.length, relative);
		}

		await removeDirAsync(TMP_DIR.replace(/\/$/, ""));
		panel.close();

		if (writeFailed.length) {
			alert(
				`有 ${writeFailed.length} 个文件写入失败：\n\n` +
					writeFailed.slice(0, 8).join("\n") +
					`\n\n旧文件已备份到扩展目录下的 _backup 文件夹，可以手动还原。`
			);
			return false;
		}

		setAppliedVersion(report.remoteVersion);
		alert(
			`更新完成：${report.localVersion || "?"} → ${report.remoteVersion || "?"}\n` +
				`共写入 ${written} 个文件` +
				(backedUp ? `，旧文件已备份到 _backup/${stamp}` : "") +
				"。\n\n点击确定后刷新界面。"
		);
		location.reload();
		return true;
	} finally {
		busy = false;
	}
}

/** 供设置页调用的入口：先检查，再问要不要装 */
export async function checkAndUpdate(force = false) {
	if (busy) {
		return;
	}
	busy = true;
	let report = null;
	try {
		report = await checkUpdates({ force });
	} finally {
		busy = false;
	}
	if (!report) {
		return;
	}
	if (report.upToDate) {
		if (force) {
			alert(`已是最新版本（${report.remoteVersion || report.localVersion || "未知"}）。\n全部 ${report.total} 个文件都与仓库一致。`);
		} else {
			alert(
				`已是最新版本（${report.remoteVersion || "未知"}）。\n\n` +
					"如果怀疑本地文件被改坏了，可以用旁边的「强制校验全部文件」重新逐文件比对。"
			);
		}
		return;
	}
	await runUpdate();
}

function formatBytes(bytes) {
	if (!bytes) {
		return "0 B";
	}
	const units = ["B", "KB", "MB", "GB"];
	let value = bytes;
	let index = 0;
	while (value >= 1024 && index < units.length - 1) {
		value /= 1024;
		index++;
	}
	return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
