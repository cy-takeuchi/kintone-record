# tsumekae

実測に基づく kintone レコードの型・変換関数・型ガード。

`@kintone/dts-gen` の `kintone.d.ts` は `kintone.app.record.get()` も
`kintone.events.on()` のハンドラ引数も `any` で、レコード周りの型を提供していない。
`@kintone/rest-api-client` は REST API の型しか持たない。
そのため実務では JS API・`event.record`・REST API の3経路が混ざり、
境界のたびに `as` が必要になる。

このリポジトリはその3経路の実際の値を測定した上で型を書き、
境界の変換を関数として提供することを目的とする。

## 型の裏づけ

型は推測ではなく**実測**に基づく。
`fixtures/measured.json` に 82 サンプル / 67 文脈あり、
e2e が実 kintone を操作して採り直せる。

- フィールド種別 28 種すべてに裏づけがある
  （`GROUP` と `REFERENCE_TABLE` は「レコードには現れない」ことを確かめた上で除外）
- レコード系イベント 30 種すべてに裏づけがある
- 書き込みの受け入れ挙動も実測（REST 20 ケース / `set()` 22 ケース）
- 2 回続けて採るとバイト単位で同じ結果になる。
  差分が出たら「kintone が変わった」と言える。週次で自動的に確かめている

### なぜ実測が要るのか

kintone は JS API の型を公式に提供していない。画面ごとの `record` の違いは、
具体的には実測しないと分からず、次の5つが実際に測って初めて分かった。

- モバイルの編集画面では、値の入っていないフィールドが `undefined` になる（PC は `""` や `null`）
- 一覧のインライン編集は `recordId` が文字列で、`submit` と `change` は `appId` まで文字列になる
- `process.proceed` は `appId` / `recordId` を持たず、`action` / `status` / `nextStatus` は `{ value: string }` になる
- 削除イベントは `record`（37 フィールドぶんの値）を持つ
- `change` は画面で形が違い、`create` は `recordId` 無し、`edit` は number、`index.edit` は string

## 使い方

```sh
pnpm add tsumekae
```

```ts
// kintone が用意しているグローバル変数 `kintone` に型を付けるための import。
// 値は何も入ってこない（型だけ）。プロジェクトのどこかに 1 回書けば全体に効く
import "tsumekae/kintone";

import { guard, setValue, toUpdateParams } from "tsumekae";

// 同じ「数値」フィールドでも、どの画面のイベントかで value の型が違う
kintone.events.on("app.record.detail.show", (event) => {
  event.recordId;  // number
  const num = event.record.数値;
  if (guard.isNumber(num)) num.value.length;  // value は string
  return event;
});

kintone.events.on("app.record.create.show", (event) => {
  // 作成画面には recordId が無い
  const num = event.record.数値;
  if (guard.isNumber(num)) num.value?.length;  // value は string | undefined。? が要る
  return event;
});

// JS API で取得したレコードを REST API に渡す
const got = kintone.app.record.get();
if (got !== null) {
  setValue(got.record, "数値", "42");
  await client.record.updateRecord(toUpdateParams(app, got.record));
}
```

### 動作条件

| | |
|---|---|
| TypeScript | 5.9 以上 |
| `moduleResolution` | `bundler` / `nodenext` |
| 実行環境 | ブラウザと Node の両方 |

`tsumekae/kintone` を import しなければ、AWS Lambda などサーバサイドで本体だけを使える。

## API

| | 用途 |
|---|---|
| `SavedRecord` / `EditingRecord` | レコード型。取得元で `value` の型が違う |
| `*RecordWithMeta` | `$id` / `$revision` を保証する版。素の型では `$id.value` が全種別の合併型になり `string` に絞れない。作成画面系以外の `event.record` は最初からこの型 |
| `SetRecord` | `kintone.app.record.set()` に渡す型。`disabled` / `error` を持てる |
| `Rest` / `RestRecord` | REST API の型 |
| `Saved` / `Editing` | フィールド型の名前空間 |
| `LooseRecord` / `LooseField` | 文脈を問わない緩いレコード型。`type` と `value` だけを持つ骨格 |
| `Api.*` | JS API が受け渡す値の型。根拠は公式ドキュメント（実測ではない） |
| `EventOf<"app.record.detail.show">` | イベント名から event の形を引く |
| `guard.*` | 型ガード |
| `field.*` | フィールドの構築 |
| `setValue` / `canSetValue` | 型安全な代入 |
| `toUpdateParams` / `toAddParams` | REST に渡すパラメータを作る |
| `toSetRecord` | `kintone.app.record.set()` に渡す形にする |
| `toRestWrite` / `toRest` | 変換の下位 API |

### `kintone` グローバル

`tsumekae` を import しても `kintone` グローバルは型付けされない。
有効にするには `tsumekae/kintone` を明示的に import する
（ライブラリが利用者のグローバルスコープを勝手に書き換えないため）。

[公式ドキュメントの JS API 一覧](https://cybozu.dev/ja/kintone/docs/js-api/)
に載っているものをすべて宣言する（2026-10-10 時点で 174 個）。
`@kintone/dts-gen` はそのうち 51 個しか宣言しておらず、
それは公式一覧の真部分集合なので dts-gen は要らない。

根拠は 2 種類あり、混ぜていない。

| 根拠 | 対象 |
|---|---|
| 実測 | `events.on` の event、`record.get()` / `set()` のレコード |
| 公式ドキュメント | それ以外すべて（`Api` 名前空間）。返る値の形は確かめていない |

`Api` は `tsumekae` と `tsumekae/kintone` の両方から import できる。
`kintone.proxy()` の戻り値のような、戻り値の中身を型として直接参照したいときに使う。

```ts
import "tsumekae/kintone";
import type { Api } from "tsumekae/kintone";

declare function handleProxyResponse(res: Api.ProxyResponse): void;
```

### `guard.*`

28 種すべてにある。 判定は `field.type === "その種別"` で、構造は見ない。

```ts
import { guard } from "tsumekae";

// undefined と null を受ける。前もって存在チェックを書かなくてよい
if (!guard.isSubtable(record[code])) return;
```

| ガード | フィールド種別 |
|---|---|
| `isRecordNumber` | `RECORD_NUMBER` |
| `isId` | `__ID__` |
| `isRevision` | `__REVISION__` |
| `isCreator` | `CREATOR` |
| `isModifier` | `MODIFIER` |
| `isCreatedTime` | `CREATED_TIME` |
| `isUpdatedTime` | `UPDATED_TIME` |
| `isStatus` | `STATUS` |
| `isStatusAssignee` | `STATUS_ASSIGNEE` |
| `isCategory` | `CATEGORY` |
| `isSingleLineText` | `SINGLE_LINE_TEXT` |
| `isMultiLineText` | `MULTI_LINE_TEXT` |
| `isRichText` | `RICH_TEXT` |
| `isNumber` | `NUMBER` |
| `isCalc` | `CALC` |
| `isLink` | `LINK` |
| `isCheckBox` | `CHECK_BOX` |
| `isRadioButton` | `RADIO_BUTTON` |
| `isMultiSelect` | `MULTI_SELECT` |
| `isDropdown` | `DROP_DOWN` |
| `isDate` | `DATE` |
| `isTime` | `TIME` |
| `isDateTime` | `DATETIME` |
| `isFile` | `FILE` |
| `isUserSelect` | `USER_SELECT` |
| `isOrganizationSelect` | `ORGANIZATION_SELECT` |
| `isGroupSelect` | `GROUP_SELECT` |
| `isSubtable` | `SUBTABLE` |

`type` を見ないものが 2 つある。

| ガード | 判定の根拠 |
|---|---|
| `isLookup` | `confirmed` と `recordId` のキーの有無。 ルックアップのキーフィールドの `type` は元フィールドの型そのもので、`type` では区別できない。REST から取ったレコードでは常に `false` |
| `hasValue` | `value !== undefined`。 `Editing` では一度も値が設定されていないフィールドの `value` が `undefined` になる。`""` や `[]` や `null` は通す |

絞り込み先は入力の型で決まる。`SavedRecord` から引けば `Saved` の型に、
`LooseRecord` から引けば 3 文脈の union になる。

```ts
const text = record[code];
if (guard.isSingleLineText(text) && guard.hasValue(text)) {
  text.value.trim();   // string
}
```

### 複数の show 系イベントを1つのハンドラーでまとめる

`create.show` / `edit.show`（PC・モバイル）/ `detail.show` を1つのハンドラーで
受けると、`record` の形が `CreateRecord` / `SavedRecord` / `EditingRecord` の
3種類になる。

`event.type` で分岐するなら、素直に絞り込める。 `EventOf<Name>` は
`Name` に union を渡すと分配されるので、配列で複数イベント名を渡した
`kintone.events.on` のハンドラーでも同様に効く。

```ts
kintone.events.on(
  ["app.record.create.show", "app.record.edit.show", "app.record.detail.show"],
  (event) => {
    if (event.type === "app.record.create.show") {
      event.reuse;     // CreateShowEvent だけが持つ
    } else {
      event.recordId;  // detail / edit 側だけ。number
    }
  },
);
```

分岐せずに横断的に読み書きしたいときは `LooseRecord` を使う。
`CreateRecord` / `SavedRecord` / `EditingRecord` はどれも
`{ [fieldCode: string]: { type: string; value: unknown } }` という骨格を
満たすので、`record` の型を `LooseRecord` として扱えばキャスト無しで代入できる。
「`record` の形が3種類になるので緩い型を自分で定義した」という同じ理由付けを
複数箇所で書き下す必要はない。

```ts
import type { LooseRecord } from "tsumekae";

function readMemo(record: LooseRecord) {
  const text = record.メモ;
  if (guard.isSingleLineText(text)) return text.value;
}
```

### REST で取ったレコードを画面に反映する

```ts
import { toSetRecord } from "tsumekae";

const { record } = await client.record.getRecord({ app, id });
kintone.app.record.set({ record: toSetRecord(record) });
```

## もっと詳しく

- [`fixtures/measured.json`](https://github.com/cy-takeuchi/jissoku/blob/main/packages/tsumekae/fixtures/measured.json) — 型の唯一の根拠。実測データそのもの
- [`fixtures/write-behavior.md`](https://github.com/cy-takeuchi/jissoku/blob/main/packages/tsumekae/fixtures/write-behavior.md) — REST 書き込みの受け入れ挙動（20 ケース）
- [`fixtures/set-behavior.md`](https://github.com/cy-takeuchi/jissoku/blob/main/packages/tsumekae/fixtures/set-behavior.md) — `kintone.app.record.set()` の受け入れ挙動（22 ケース）
- [設計判断の記録](https://github.com/cy-takeuchi/jissoku/blob/main/packages/tsumekae/docs/DECISIONS.md) — 何を決めたか、何を捨てたか、なぜ捨てたか。
  実測で判明した kintone / API の制約と、測り方を間違えた記録も入っている
- [開発する](https://github.com/cy-takeuchi/jissoku/blob/main/packages/tsumekae/CONTRIBUTING.md) — 実測の手順。共通の手順は[ルート](https://github.com/cy-takeuchi/jissoku/blob/main/CONTRIBUTING.md)

## ライセンス

[MIT](LICENSE)
