import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { OFFICIAL_JS_APIS } from "./jsApi";

/**
 * `src/kintone.ts` の宣言が公式ドキュメントの一覧と一致していることを確かめる。
 *
 * ## なぜソースを読むのか
 *
 * 型テスト（`.test-d.ts`）だと「呼べること」は確かめられるが、
 * **174 個ぶん呼び出しを書かないと網羅にならない**うえ、
 * 書き忘れた API があっても緑のままになる。
 * ここでは宣言そのものを数え、**足りないほうと余っているほうの両方**を落とす。
 *
 * ## dts-gen より狭くなっていないこと
 *
 * 併せて `@kintone/dts-gen` が宣言しているものをすべて含むかも見る。
 * tsumekae が dts-gen の置き換えを名乗る以上、**狭くなったら意味が無い**。
 * dts-gen の 51 個は公式一覧の真部分集合なので、
 * 公式一覧を満たしていれば自動的に満たされる。それを明示的に確かめる。
 */

/** `declare global` の中の名前空間と関数を、フルパスに組み立てる */
const declaredIn = (source: string): Set<string> => {
	const declared = new Set<string>();
	const stack: { indent: number; name: string }[] = [];

	for (const line of source.split("\n")) {
		const body = line.trimStart();
		if (body === "" || body.startsWith("*") || body.startsWith("//")) continue;

		const indent = line.length - line.replace(/^\t+/, "").length;
		while (stack.length > 0 && (stack.at(-1)?.indent ?? 0) >= indent) {
			stack.pop();
		}

		const namespace = /^\t*namespace (\w+) \{/.exec(line);
		if (namespace?.[1] !== undefined) {
			stack.push({ indent, name: namespace[1] });
			continue;
		}

		const member = /^\t*(?:function|const) (\w+)/.exec(line);
		if (member?.[1] !== undefined && stack.length > 0) {
			declared.add(`${stack.map(({ name }) => name).join(".")}.${member[1]}`);
		}
	}
	return declared;
};

const declared = declaredIn(readFileSync("src/kintone.ts", "utf8"));

describe("公式ドキュメントの JS API をすべて宣言している", () => {
	test("宣言が 1 つも欠けていない", () => {
		const missing = OFFICIAL_JS_APIS.filter((api) => !declared.has(api));
		expect(missing).toEqual([]);
	});

	test("公式に無いものを宣言していない", () => {
		const official = new Set<string>(OFFICIAL_JS_APIS);
		const extra = [...declared].filter((api) => !official.has(api)).sort();
		expect(extra).toEqual([]);
	});

	test("数が合っている", () => {
		expect(declared.size).toBe(OFFICIAL_JS_APIS.length);
	});
});

describe("@kintone/dts-gen より狭くない", () => {
	// dts-gen が宣言している 51 個。公式一覧の真部分集合であることを確認済み。
	// 置き換えを名乗る以上、ここが欠けたら意味が無い。
	// 一覧は node_modules に依存させない。dts-gen は devDependency ですらなく、
	// 「捨てたもの」なので、その内容をこちらの資産として持つ
	const DTS_GEN_APIS = [
		"kintone.api",
		"kintone.api.getConcurrencyLimit",
		"kintone.api.url",
		"kintone.api.urlForGet",
		"kintone.app.getFieldElements",
		"kintone.app.getHeaderMenuSpaceElement",
		"kintone.app.getHeaderSpaceElement",
		"kintone.app.getId",
		"kintone.app.getLookupTargetAppId",
		"kintone.app.getQuery",
		"kintone.app.getQueryCondition",
		"kintone.app.getRelatedRecordsTargetAppId",
		"kintone.app.record.get",
		"kintone.app.record.getFieldElement",
		"kintone.app.record.getHeaderMenuSpaceElement",
		"kintone.app.record.getId",
		"kintone.app.record.getSpaceElement",
		"kintone.app.record.set",
		"kintone.app.record.setFieldShown",
		"kintone.app.record.setGroupFieldOpen",
		"kintone.events.off",
		"kintone.events.on",
		"kintone.getLoginUser",
		"kintone.getRequestToken",
		"kintone.getUiVersion",
		"kintone.mobile.app.getFieldElements",
		"kintone.mobile.app.getHeaderSpaceElement",
		"kintone.mobile.app.getId",
		"kintone.mobile.app.getLookupTargetAppId",
		"kintone.mobile.app.getQuery",
		"kintone.mobile.app.getQueryCondition",
		"kintone.mobile.app.getRelatedRecordsTargetAppId",
		"kintone.mobile.app.record.get",
		"kintone.mobile.app.record.getFieldElement",
		"kintone.mobile.app.record.getId",
		"kintone.mobile.app.record.getSpaceElement",
		"kintone.mobile.app.record.set",
		"kintone.mobile.app.record.setFieldShown",
		"kintone.mobile.app.record.setGroupFieldOpen",
		"kintone.mobile.portal.getContentSpaceElement",
		"kintone.mobile.space.portal.getContentSpaceElement",
		"kintone.plugin.app.getConfig",
		"kintone.plugin.app.getProxyConfig",
		"kintone.plugin.app.proxy",
		"kintone.plugin.app.proxy.upload",
		"kintone.plugin.app.setConfig",
		"kintone.plugin.app.setProxyConfig",
		"kintone.portal.getContentSpaceElement",
		"kintone.proxy",
		"kintone.proxy.upload",
		"kintone.space.portal.getContentSpaceElement",
	] as const;

	test("dts-gen の宣言をすべて含む", () => {
		const missing = DTS_GEN_APIS.filter((api) => !declared.has(api));
		expect(missing).toEqual([]);
	});

	test("dts-gen の一覧は公式一覧に含まれている", () => {
		const official = new Set<string>(OFFICIAL_JS_APIS);
		const outside = DTS_GEN_APIS.filter((api) => !official.has(api));
		expect(outside).toEqual([]);
	});
});
