# 設計判断の記録

`tsumekae` の設計を決めるにあたって検討した内容と、その根拠。

このドキュメントの目的は「何を決めたか」より **「何を捨てたか、なぜ捨てたか」** を残すこと。
決定だけならコードを読めば分かるが、却下した選択肢は消えてしまうため、同じ検討を繰り返すことになる。

調査時点: 2026-08-30
対象バージョン: kintone-typeguard 0.18.3 / kintone-pretty-fields 0.11.0 / @kintone/rest-api-client 6.2.1 / @kintone/dts-gen 9.x

---

## この文書に無いもの

モノレポ化にあたって、**パッケージ固有でない記述を上へ移した**（2026-09-10）。

| | 場所 |
|---|---|
| kintone 自体の挙動（実測で判明した事実 / API の制約 / `set()` の受け入れ / 行操作のイベント / フォーム定義の実測） | [`docs/KINTONE.md`](../../../docs/KINTONE.md) |
| 環境とツールチェーン（publish / ncu / pnpm / Secret / Actions / TypeScript 2 版検査 / ライブ検証の判定場所） | [`docs/TOOLCHAIN.md`](../../../docs/TOOLCHAIN.md) |

**判断の記録はここ、事実は上。** ここに残っているのは
「tsumekae がなぜそう作られているか」だけ。
kintone がどう振る舞うかは、kisekae にも次のパッケージにも要るので上に置く。


## 背景

kintone のレコードには3つの取得・更新経路があり、それぞれ型の出どころが違う。

| 経路 | 型の出どころ | 状態 |
| --- | --- | --- |
| JS API (`kintone.app.record.get/set`) | `@kintone/dts-gen` | **`any`**。型が無い |
| `event.record` (`kintone.events.on` のコールバック) | `@kintone/dts-gen` | **`any`**。ハンドラ引数が `(event: any) => any` |
| REST API | `@kintone/rest-api-client` | REST の型のみ。JS API とは別物 |

さらに `event.record` は画面（作成 / 詳細 / 編集）によって形が違うが、
`dts-gen` はその区別を持たない。

プラグイン実装では「JS API で取得したものを REST に渡す」「その逆」が日常的に発生するため、
境界のたびに `as` が必要になっていた。

---

## 決定サマリ

| # | 論点 | 決定 |
| --- | --- | --- |
| 1 | 成果物の範囲 | 型 + 変換関数 + typeguard を1パッケージに集約 |
| 2 | 型モデル | 手段の4象限 + イベント名→event型のマップ |
| 3 | 実測スコープ | 全フィールド種別 × 主要イベント × 3経路の突き合わせ |
| 4 | 実測の忠実度 | `JSON.stringify` 禁止。キーの存在を保持する独自形式 |
| 5 | 検証アプリ | REST 構築スクリプト + テストレコード投入まで自動化 |
| 6 | テスト戦略 | PR は高速テストのみ。実 kintone は定期ジョブで差分検出 |
| 7 | 変換の判断根拠 | `type` だけを見る同期の純粋関数（実測によりメタ情報は不要と判明） |
| 8 | 変換の方向 | REST 型を Canonical と位置づける。加えて構築 API と代入 API |
| 9 | イベント網羅 | ほぼ全イベント + 未知イベントのフォールバック |
| 10 | 移行 | 新パッケージ名。kintone-typeguard は凍結、シムを作らない |

---

## 1. 成果物の範囲

**決定**: 正確な `kintone.d.ts`（レコード周りのみ全面改訂、それ以外は dts-gen 準拠）と、
境界変換関数、typeguard を1パッケージに集約する。kintone-typeguard は将来的に吸収する。

**理由**: 型だけでは `as` は消えない。JS API と REST は「型が違う」だけでなく
**実行時の値そのものが違う**（`SUBTABLE` の `id`、未入力値の表現）ため、変換コードが必須になる。

> **2026-08-30 追記**: 当初この根拠に `FILE` の `value` 形状も挙げていたが、
> 実測の結果 **`FILE` は JS API の形（`contentType` / `name` / `size` 付き）のまま
> REST に投げても正しく保存される**ことがわかった。この 1 点は根拠から外れる。
> 一方 `SUBTABLE` の `id` は健在で、落とすと行が置き換わってデータが壊れる。
> さらに実測で、未入力値の表現が文脈ごとに `undefined` / `""` / `null` に分かれることも判明し、
> 変換が必要だという結論自体はより強くなった。

**捨てた選択肢**

- **型定義のみ**（変換関数を持たない） — 上記の理由で `FILE` / `SUBTABLE` の `as` が原理的に消えない
- **ラッパー API**（`kintone` グローバルを直接触らせない） — kintone の API 面積（`getFieldElement`、`setFieldShown`、mobile 系、一覧画面…）まで抱えることになり維持コストが見合わない。レコードだけラップして他は生 kintone、という混在も学習コストが高い
- **typeguard を別パッケージに残す** — 「型は tsumekae、絞り込みは kintone-typeguard」だと依存が循環的になり、`FFF<A,B,C,D>` のような無理な型合成が再発する。型と絞り込みは同じ場所で定義すべき

**kintone-pretty-fields は統合対象外**。フィールド**定義**（`getFormFields`）を扱うもので、
レコード**値**を扱う本パッケージとは責務が分かれている。
ただし変換関数はその出力形に適合する最小インターフェースを受け取れるようにする（依存は持たない）。

---

## 2. 型モデル

**決定**: 「手段の4象限（JS読み / JS書き / REST読み / REST書き）」に加えて、
**イベント名リテラルから event 型を引くマップ**を持つ。

```ts
type KintoneEventMap = {
  "app.record.create.show": { type: "app.record.create.show"; appId: number; record: Record.CreateShow };
  "app.record.edit.show":   { type: "app.record.edit.show"; appId: number; recordId: number; record: Record.EditShow };
  // ...
};
function on<E extends keyof KintoneEventMap>(
  event: E | E[],
  handler: (event: KintoneEventMap[E]) => KintoneEventMap[E] | Promise<KintoneEventMap[E]> | void,
): void;
```

**理由**: kintone-typeguard は `Get` / `Set` / `Event` / `Unified` の4名前空間だが、
これは**「手段」だけの軸**で切られていて**「画面」の軸が無い**。
そのため各プラグインがイベント型を手書きで重複させていた。

実測（2026-08-30 時点）: 6 つのプラグインがそれぞれ 12〜35 行の
イベント型を手書きしており、**すべて内容が微妙に違って一貫性が無い**。
根本原因は `kintone.events.on(event: string, handler: (event: any) => any)` が `any` であること単体。
`events.on` を型付けするだけでこの重複は全廃できる。投資対効果が最大。

**画面ごとのレコード型は手書きせず、ベース型からの機械導出**（`Omit` / `Readonly` 等）にする。
その差分が実際に何なのかを確定させるのが実測の役割。

**捨てた選択肢**

- **手段の4象限のみ**（画面差を型に出さない） — 「create の `event.record` には `$id` が無い」といった差を `$id?` に倒すしかなく、edit 画面で毎回 undefined チェックを強いる。型の意味が薄れる
- **Canonical 1型に統一**（読みは全部正規化、書きは `Partial`） — `event.record` は**書き換えて `return event` する**のが kintone の契約なので、正規化した別型に変換すると元に戻せない。`event.record` だけは実物の形をそのまま型にする必要がある
- **条件型でフィールドを文脈パラメータ化**（`Field.Number<"EditShow">`） — `FFF<A,B,C,D>` の反省がそのまま当てはまる。ホバー表示とエラーメッセージが壊滅的になり、絞り込み後に何の型か読めなくなる

---

## 3. 実測スコープ

**決定**

- **イベント**: create / detail / edit の各 show、`*.submit`、`*.submit.success`、`*.change.<field>`、`app.record.index.show`、インライン編集
- **経路**: `event.record` / `kintone.app.record.get()` / REST `getRecord` を**同一レコードで突き合わせる**
- **フィールド**: 全種別を網羅。Lookup・関連レコード・グループ・テーブル・カテゴリ・ステータス・作業者を含む。**間引かない**
- **状態**: 未入力 / 入力済みの両方
- **mobile**: スポット確認のみ
- **フィールドアクセス権による欠落**: **型に出さない**

**理由**

経路の突き合わせこそが「get の結果を REST に渡す / その逆」という当初の課題そのもので、
変換関数のシグネチャは REST との実測差分がないと書けない。

`submit` 系も落とせない。調査したプラグインはテーブル行を
`event.record` に push しており、ここが実測未確定のまま `@ts-expect-error` になっていた。

フィールド種別を間引くと Lookup や関連レコードのような一番厄介なものが漏れる。

**アクセス権を型に出さない理由**: 「非表示フィールドは record から消える」を型で表すと
**全フィールドが optional になり、型が死ぬ**。これは型ではなく実行時 guard の責務。

**捨てた選択肢**

- **mobile 全網羅** — PC とイベント名以外は同形という前提。全網羅する価値が低い
- **ゲストスペース / 英語ロケール** — レコードの**値と構造**には影響せず、変わるのは URL とラベル表示だけ

---

## 4. 実測の忠実度

**決定**: `JSON.stringify` を使わない。`Object.keys()` でキー集合を保持し、
各値を `{ present, typeof, value }` 相当の形式に包んで
`undefined` / `null` / `""` / `[]` をすべて区別する。

**理由**

```js
JSON.stringify({ error: undefined }) === "{}"   // キーが消える
```

測定目的は `disabled?` / `error?` / `$id?` / `id?` が optional かどうかの判定、
つまり**キーの有無そのもの**。素朴なダンプでは目的が最初の一手で壊れる。

あるプラグインが `viewId?: undefined` という奇妙な型を手書きしていたのは、
この区別が曖昧なまま推測で書いた痕跡と見られる。

**この設計が効いていることの確認**（合成データでのパイプライン検証）:

```

## SINGLE_LINE_TEXT
| app.record.create.show / event.record | `error` | 必須 | `undefined` |
| app.record.edit.show / event.record   | `error` | 必須 | `null`      |
| screen.edit / rest.getRecord          | (キー自体が無い)       |
```

`error` が「値 undefined で存在」「値 null で存在」「キーごと不在」の3状態で区別できている。

**構造チェックは1回だけ**別途実行する（`inspectStructure`）。
`event.record` が素の data property の集合か、getter / 非列挙キーを持つかの確認。
immer の `createDraft` を通しているプラグイン実装の前提検証が目的。
フィールドごとに毎回採ると出力が数倍に膨れ、分析が重くなるだけ。

**採取と分析を分離する**。ブラウザ側は生データ採取のみ、
スキーマ化・型生成はリポジトリ内の Node スクリプト。
採取コードを再アップロードせずに分析だけ何度でも回せるようにするため。

**捨てた選択肢**

- **時系列スナップショット**（表示直後 / 値変更後 / `set()` 後） — 今回の目的は「型」であって「ミューテーション意味論」ではない。`event.record` を書き換えて `return event` する契約は実運用で確認済み

---

## 5. 検証アプリ

**決定**: REST 構築スクリプトをリポジトリに置く。
測定用アプリとルックアップ参照先アプリの2つを作り、テストレコード投入まで自動化する。

**理由**

- **アプリテンプレート zip は不採用**。実質バイナリで diff が効かず、「なぜこのフィールド構成なのか」をレビューできない。差分更新もできない。実測を根拠に型を書く以上、根拠側がブラックボックスなのは本末転倒
- **レコード投入まで自動化しないと条件がブレる**。`DROP_DOWN` の未入力が `null` か `""` かを確定させるのが目的なのに、手入力に委ねたら再実行のたびに条件が変わる
- **Lookup は参照先にレコードが無いとルックアップを実行できず**、コピー先フィールドが空のまま＝測定にならない。参照先アプリとそのレコード投入は必須

**捨てた選択肢**

- **手作業 + テンプレート zip** — 上記のとおり追試不能
- **環境バリエーション**（ゲストスペース / ロケール / アクセス権パターン） — レコードの値と構造に影響しない、または #3 で型対象外と決めた

---

## 6. テスト戦略

**決定**

- **PR で回すのは型チェック・Lint・凍結フィクスチャに対するテストのみ**。実 kintone には接続しない
- **実 kintone を使う検証は定期スケジュールジョブに分離**し、そこでは**フィクスチャと実測の diff** で落とす

**理由**

このライブラリの正しさの主張は **「宣言した型が、kintone が実行時に返す実物と一致している」** の一点。
通常の単体テストでは守れず、実物と繋がないと検証できない。
しかし実物と繋ぐと CI が遅く不安定になる。

**これは既に一度起きている**。kintone-typeguard には実 kintone に接続するテストが
`src/test/vitest/typeguard.test.ts`（175行）として書かれているが、
`.github/workflows/check.yml` の `Run Tests` ステップは**コメントアウトされている**。
PR ごとにライブ実行する設計を選べば、同じ結末をなぞることになる。

責務を分けることで、PR は速いまま、実物との乖離は最大1週間で検出できる。
差分が出たら「フィクスチャ更新 PR」を自動で立てれば、更新が人の記憶に依存しなくなる。

**採取コードを二重に持たない**。
kintone-typeguard の `src/test/functions/customize.ts` のように
テンプレート文字列で JS を持つ方式は、採取ロジックが育った瞬間に破綻する。
採取コードは通常の TypeScript ソースとして書き、ビルドで IIFE 1ファイルを吐き、
それを (1) 人間が手動でアプリに貼る (2) Playwright が `updateAppCustomize` でアップロードする
の両方から**同じ成果物として使う**。
これが崩れると、手動で採った実測と CI が検証している実測が別物になる。

**捨てた選択肢**

- **型テストのみ**（実 kintone に一切繋がない） — kintone は年に何度も更新される。実物が変わったことに気づく仕組みがないなら「今日時点で正しい」で終わり、dts-gen と同じ状態に戻る
- **PR ごとのライブ実行** — アプリ作成・デプロイは非同期で数十秒、`workers: 1` 強制、API 日次上限あり。必ず無効化される

**道具**: vitest の `expectTypeOf` + `@ts-expect-error` を踏襲。
tsd / expect-type への乗り換えは利得がなく、既存資産と CI 設定を捨てるコストだけが残る。

---

## 7. 変換関数の判断根拠

> **2026-08-30 追記: 実測により結論が変わった。**
> 当初は「ルックアップのコピー先はレコードの値から判別できないので、
> `getFormFields` のメタ情報を任意引数で受け取る」と設計した。
> 実際に REST へ投げて確かめたところ、**コピー先を含めてもエラーにならず黙って無視される**。
> よって **メタ情報の引数そのものが不要**になり、変換は完全に静的な純粋関数になる。
> 詳細は「REST updateRecord の受け入れ挙動」の節と `fixtures/write-behavior.md` を参照。

**決定（改訂後）**: 変換は **`type` だけを見る同期の純粋関数**。
フィールドメタ情報も `getFormFields` も要らない。

`forRestWrite` がやることは 2 つだけ。

1. 書き込みが拒否される 9 種の `type` を落とす
2. `$id` / `$revision` を分離して `id` / `revision` パラメータへ回す

**当初この設計に至った経緯（記録として残す）**

変換で落とす / 変形する対象と、その判断に必要な情報を次のように整理していた。

| 対象 | 当初の想定 | 実測結果 |
| --- | --- | --- |
| `RECORD_NUMBER`、`CREATOR`、`CREATED_TIME`、`MODIFIER`、`UPDATED_TIME` | 落とす | **落とさないとエラー（`GAIA_UN10`）** |
| `STATUS`、`STATUS_ASSIGNEE` | 落とす | **落とさないとエラー（`GAIA_UN10`）** |
| `GROUP` | 想定していなかった | **落とさないとエラー（`GAIA_UN10`）** |
| `CATEGORY` | 落とす | **落とさないとエラー（`GA_UO01`）** |
| `CALC` | 落とす | 無視される。落とさなくてもよい |
| `FILE` | `{fileKey}[]` に縮約が必要 | **縮約不要。JS API の形のまま通る** |
| `SUBTABLE` の `id` | 保持する | **保持が必須。落とすと行が置き換わる** |
| `disabled` / `error` | 落とす | 無視される |
| `$id` / `$revision` | 落とす（`$revision` は別引数へ） | 無視される |
| **ルックアップのコピー先** | **メタ情報が必要** | **無視される。メタ情報は不要** |

ルックアップのコピー先について当初メタ情報が要ると考えたのは、
`kintone-pretty-fields/src/functions/formField.ts` の `isLookupCopy` が
`getFormFields` の結果から、しかもルックアップ元アプリの権限を持って初めて判定できる
（README にも "Requires lookup source app permissions"）ためである。
判別自体はいまも値だけではできない。
**判別する必要がなくなった**、というのが実測でわかったこと。

**捨てた選択肢**（実測前の検討。いずれも結論は変わらない）

- **メタを必須引数にする** — 「`event.record` をそのまま REST に投げたいだけ」という最頻ケースに `getFormFields` の取得を強制することになる。さらにルックアップ元アプリの権限が無い環境では取得自体が失敗する
- **変換関数が内部で `getFormFields` を呼ぶ（async 化）** — ループ内で呼べば N 回 API を叩く。一括更新の実装で即座に破綻する

**粒度**: 一括変換を主 API、フィールド単位変換を下位 API として**両方公開する**。
`SUBTABLE` の再帰があるためフィールド単位だけでは利用者が再帰を書く羽目になり、
`as Subtable["value"]` のようなキャストが再生産される。
逆に一括だけだと、テーブル 1 行だけを変換したいケースが書けない。

**「動作上不要」でも変換で落とすもの**

`disabled` / `error` / `confirmed` / `recordId` / `$id` / `$revision` と `FILE` の余分なプロパティは、
渡してもエラーにならないので**落とさなくても動く**。それでも変換では落とす。
型の上で「REST に渡せる形」を表現するため、
および送信ペイロードを不必要に膨らませないため。
ただしこれは**正しさの要件ではなく整形**であり、落とし漏れがあっても壊れない。

## 8. 変換の方向と、変換だけでは足りないこと

**決定**: REST 型を Canonical と位置づける。**加えて、構築 API と型安全な代入 API を提供する**。

```ts
toRest(uiRecord)             // UI(get/event) → Canonical。同期・純粋
toUi(restRecord)             // Canonical → UI 型。実行時はほぼ恒等だが関数として公開
forRestWrite(record)         // Canonical → addRecord/updateRecord のパラメータ
forJsSet(record)             // Canonical → kintone.app.record.set() の入力
```

**Canonical を新設しない理由**: `@kintone/rest-api-client` の `KintoneRecordField` が
既に事実上の正規形として機能している。kintone-typeguard の `Unified` namespace
（`src/types/recordFieldUnified.ts`）がそれを丸ごと再エクスポートしているのがその証拠。
**既にあるものを Canonical と宣言するだけで足りる**。

**`toUi` は実行時にはほぼ恒等関数**（REST 読み型の `FILE` は `contentType/name/size` を持ち UI と同形、
`SUBTABLE` の `id` も同様）。
ただし実測では未入力値の表現が違う（`DROP_DOWN` は REST が `null`、JS API が `""`）ため、
恒等で済むかは画面別型を書いたあとに再判定する。それでも名前付き関数として公開する。
`as` を1箇所に集約でき、将来 kintone 側に差分が生まれたときの修正点が1つになるため。

**捨てた選択肢**

- **独立した Canonical 型を新設** — 型が5つ目になり学習コストだけ増える
- **実需のある方向だけ直接変換**（ハブなし） — 方向が増えるたびに N² で増える
- **単一 API に宛先を渡す**（`convert(record, "rest:add")`） — 入力がどの文脈のレコードかを構造から自動判別できない。`disabled` / `error` を持たない UI レコード（未編集の detail 画面など）と REST レコードは**完全に同形**。誤判別が静かなバグになる

### 変換だけでは足りない（重要）

実在のプラグイン群のレコード入出力を全て洗った結果、
**変換でカバーできるのは一部だけ**だった。

| 性質 | 変換でカバー |
| --- | --- |
| REST 読み取り → UI へ渡す | ✅ |
| REST の入出力に JS API の型を当てている誤り | ✅ Canonical 制定で是正 |
| event.record を REST の `updateAllRecords` へ渡す | ✅ |
| **部分レコードをゼロから構築する** | ❌ |
| **テーブル行のフィールド値へ代入する** | ❌ |
| **`FILE` を手で構築する** | ❌ |
| **サーバ側（Lambda）でレコードを構築する** | ❌ |

**カバーできない側は全て「構築」と「代入」**。よって
**フィールド構築 API（`field.number(x)` など）と型安全な代入 API（`setValue(record, code, value)`）を併せて提供する**。

**`Record` 型全体の `Readonly` 化は不採用**。
`event.record` は「書き換えて `return event` する」のが kintone の契約なので、正規の使い方ができなくなる。
`Readonly` にできるのは detail 画面など読み取り専用文脈だけで、それは #2 の画面別型で表現すべきもの。

---

## 9. イベント網羅

**決定**: ポータル・スペース・グラフを含むほぼ全イベント（約60種）を型付けし、
**未知イベントのフォールバックを持つ**。

**フォールバックの形**: `E | (string & {})`。
既知イベントの補完を効かせたまま未知の文字列も受けられ、未知側だけ緩い型になる。

**理由**

閉じたマップ（`E extends keyof KintoneEventMap`）だけにすると、
kintone が新イベントを追加した瞬間、利用者はライブラリの更新を待つまでそのイベントを使えなくなる。
型付けの利得と引き換えに利用者をブロックする側に回る。

一方、単純な `on(event: string, ...)` オーバーロードを足すと
**タイポが静かに通ってしまい型付けの意味が消える**。

**実使用は13種だが、それを境界にしない**。
調査したプラグイン群が実際に使っているのは以下の13種のみ。

```
app.record.index.show / detail.show / edit.show / create.show / print.show
app.record.create.submit.success / edit.submit.success
mobile.app.record.index.show / detail.show / edit.show / create.show
mobile.app.record.create.submit.success / edit.submit.success
```

しかしこれは「たまたま今使っている範囲」であってライブラリの適切な境界ではない。
特に **`app.record.create.submit` / `edit.submit`（保存前検証、`event.error` を設定して保存を止める）は
kintone カスタマイズの最頻用途の一つ**で、これを型付けできないライブラリは標準的な使い方から外れる。
調査対象が使っていない方が例外的。`.change.<field>` も同様。

`portal.show` / `space.portal.show` / `app.report.show` は**レコードを持たない**ので型は数行で終わる。
網羅しないコストの方が高い。

**ただし実測の裏付けがあるのはレコード系だけ**。
portal / space / report は公式ドキュメント準拠で書き、
**実測済みかどうかを JSDoc で明示的に区別する**。
「実測に基づく」が売りである以上、根拠のレベルが違うものを黙って混ぜるのは誠実さを欠く。

**型付けで特に価値が高いもの**

- **`submit` 系**: 戻り値に `error` を設定できる特殊な契約（`return {...event, error: "メッセージ"}` で保存中断）
- **`.change.<field>`**: イベント名にフィールドコードが埋まる動的イベント。テンプレートリテラル型で表現。この系統だけが持つ `event.changes` の形も実測対象

---

## 10. 移行

**決定**: 新パッケージ名で出し、kintone-typeguard は凍結する。
**deprecated エイリアスもシムも作らない**。
利用側は両方を併存させ、**プラグイン単位で移行**する。

**理由**

- **旧 `Record` 型は「非推奨にすべき古い API」ではなく「安全でない型」**（後述の実測を参照）。deprecated エイリアスやシムで残すのは、危険な型に公式の生存期間を与えることを意味する。新旧が混在した状態で「この `Record` はどちらの型か」が読めなくなる期間も長く続く
- **名前空間の意味そのものが変わる**。「手段による分割」から「画面別 + Canonical」へ軸が変わるので、同じパッケージ名で出すと「更新したら型の意味が変わっていた」になる。kintone-typeguard は npm 公開パッケージで外部利用者がいる可能性があり、なおさら
- **一括移行はリスクだけ大きい**。55ファイルを一度に触ると、型設計の誤りが見つかったときの手戻りが最大化する

**移行順序**: **最も規模が大きく、難所を全部含むものから着手する**。
最小のものからではない。
`Subtable` の immer 経由の書き換え、REST → UI のキャスト、
`Set.File` の手構築、`event.record` から REST 一括更新への変換。
ここが通れば残り7つは軽い。
逆に最小のもの（2 ファイル）から始めると、
簡単なものだけ移行が済んだ状態で難所にぶつかり、設計をやり直す羽目になる。
**最初の1つで設計を検証するのが目的**。

**機械置換は成立しない**。`Set.Record` の46件は移行先が
`kintone.app.record.set()` 用と REST `updateRecord` 用の2つに割れる
（共通クライアントが現に REST に `Set.Record` を当てていた）。
どちらに向かうかは呼び出し先を見ないと決まらない。

### 名前の対応表は README ではなくここに置く

**2026-09-09。** README に「`kintone-typeguard` からの移行」の節を置いていたが、
**利用者向けの文書には要らない**という判断で落とした。
表そのものは捨てないので移す。

綴りが違うのは 3 つだけで、**コンパイルエラーになるので黙って壊れない**。

| kintone-typeguard | tsumekae |
|---|---|
| `guardRecord.isDatetime` | `guard.isDateTime` |
| `guardRecord.isDropDown` | `guard.isDropdown` |
| `guardRecord.isID` | `guard.isId` |

28 種別すべてに対応があり、抜けは無い（機械的に突き合わせ済み）。
`guard.isLookup` と `guard.hasValue` が増えている。

型は 1 対 1 にならない。**ここが移行の見積りを決める。**

| kintone-typeguard | tsumekae |
|---|---|
| `kintoneRecordFieldGet.Record` | **`SavedRecord` / `EditingRecord` / `RestRecord` の 3 つに割れる** |
| `kintoneRecordFieldEvent.*` | `EventOf<"app.record.detail.show">` など |
| `kintoneRecordFieldSet.Record` | `SetRecord` |
| `kintoneRecordFieldUnified.*` | `Rest.*` / `RestRecord` |
| `guardUtils.converterGetToSet` | `toSetRecord`（落とす対象は実測で決めたので中身は違う） |
| `guardFormField` / `guardFormLayout` | **無い。** 守備範囲外（[フォーム定義は守備範囲に入れない](#フォーム定義は守備範囲に入れない)） |

`Get` の 1 型が 3 つに割れるので、**呼び出しごとに「どの文脈のレコードか」を
判断する必要がある**。3 つを 1 つに潰していたことが kintone-typeguard の
緩さの正体で、分かれていること自体が tsumekae の存在理由でもある。

---

## 未確定事項

| # | 内容 | 判断の材料 |
| --- | --- | --- |
| 1 | テーブル内フィールドのコードでも change イベントが発火するか | 採取ツールは修正済み。次回の採取で確認できる |
| 2 | `error` を設定して `submit` を返したときの挙動（保存が止まるか） | 型は optional で書けるので急がない |
| 3 | 画面別レコード型の具体的な導出規則 | `value` の型自体が画面ごとに違うことが判明したため、`Omit` / `Readonly` では表せない。実測レポートの表を根拠に個別に定義する |
| 4 | 代入 API のフィールドコード解決方式 | `@kintone/dts-gen` のアプリ固有型と組み合わせた場合と、コードが `string` の動的ケースの二段構え |
| 5 | モバイルの submit / change / process の採取 | show 系は採取済み。残りは未採取。モバイルの編集画面が PC と違ったので、他も「PC と同形」と決めつけない |

**決着した項目**

| 内容 | 結論 | 決着日 |
| --- | --- | --- |
| ルックアップのコピー先を REST 書き込みに含めるとどうなるか | **無視される**。変換にメタ情報は不要 | 2026-08-30 |
| メタ有無で戻り値をブランド型で区別するか | **不要**。区別する対象が消えた | 2026-08-30 |
| `Rest` を `@kintone/rest-api-client` に委ねるか | **委ねない。自前で持つ。** 2026-08-30 に「新しい正規形は作らない」と決めていたが、**その決定を実測で覆した**。委譲の代償が検出できない `any` だと分かり、緩和策も全て効かなかった。守るものが 2 つあるので、テストも 2 つ置く（あちらとの等価性 / 実測との一致） | 2026-09-05 |
| 印刷画面で採取できるか | **できる**。ヘッダが無いのでパネルは出ないが、カスタマイズ JS は動き `app.record.print.show` が飛ぶ。パネルの有無と採取可否は別物だった。採れるのは `event.record` だけで、ボタン起動の `get()` / REST は採れない | 2026-09-02 |
| モバイルで採取できるか | **できる**。`kintone.mobile.app.getHeaderSpaceElement` があるのでパネルも載る。`create` / `edit` / `detail` / `index` の show が飛ぶ | 2026-09-05 |
| モバイルは PC と同形か | **違う**。`mobile.app.record.edit.show` の record は Saved ではなく **Editing**（値の無いフィールドが `undefined`）。詳細画面は PC と同形だったので、読み込み途中を拾ったわけではない | 2026-09-05 |
| 一覧のインライン編集は編集画面と同形か | **違う**。`app.record.index.edit.*` は `recordId` が文字列。`submit` と `change` は `appId` まで文字列（他のイベントは number） | 2026-09-05 |
| `change` イベントは画面によらず同形か | **違う**。`create.change.*` は `recordId` を持たず、`edit.change.*` は number、`index.edit.change.*` は string | 2026-09-05 |
| モバイルの submit / change / process は PC と同形か | **`submit.success` だけ違う。`appId` が文字列**（PC は number）。`submit` / `change` / `process.proceed` は同形で、`create.change` が `recordId` を持たないところまで一致した。`kintone.app.record.get()` の戻りも PC と同じ | 2026-09-05 |
| `DeleteSubmitEvent` は record を持たないか | **持つ。** 完全な Saved レコード（37 フィールド、空は `""` / `null`、システムフィールドあり）。PC 詳細 / モバイル詳細 / PC 一覧の 3 経路とも同形で、`appId` も `recordId` も number。**一覧からの削除も number** で、一覧のインライン編集（文字列）とは違う。「一覧のイベントは文字列」という括り方はできない | 2026-09-05 |
| モバイルのプロセス管理は PC と同じか | イベントの形は同じ。**掴み方だけ違う**。PC は role を持たない `<span title="処理開始">`、モバイルは本物の button で名前が「処理開始 (Proceed status)」。確認ダイアログで確定してから飛ぶのは共通 | 2026-09-05 |
| `ProcessProceedEvent` の形 | `appId` も `recordId` も**持たない**。`action` / `status` / `nextStatus` は文字列ではなく `{ value: string }`。`status` は遷移**前**、`nextStatus` が遷移**後** | 2026-09-05 |

## 型の名前

フィールド型の名前空間は **`Saved` / `Editing` / `Rest`** の 3 つ。

実測が示した区別は「保存されている値がそのまま渡されるもの」と
「編集中のフォームが保持している値」なので、名前もそれをそのまま表す。

| 名前空間 | 出どころ | 特徴 |
| --- | --- | --- |
| `Saved` | `detail.show` / `index.show` / `edit.show` / `submit.success` の event.record | サーバ由来。undefined は現れない |
| `Editing` | 作成画面、`kintone.app.record.get()`、`change.*` / `submit` の event.record | フォームの状態。未入力が undefined |
| `Rest` | REST API | `@kintone/rest-api-client` の `KintoneRecordField` を名前だけ揃えて再エクスポート。`DROP_DOWN` が null になりうる |

**捨てた候補**

- `View` / `Live` — 当初の案。`Live` が何を指すか読んで分からない。`edit.show` は編集画面なのに `View` に入るのも直感に反する
- `Server` / `Form` — 出どころで説明する案。`Rest` もサーバ由来なので `Server` との境界が曖昧になる
- `Displayed` / `Editing` — `submit.success` が表示ではないので当てはまりが悪い
- `Normalized` / `FormState` — 実装の事実には最も忠実だが、kintone を知っていても一読で意味が取れない

## 全種別の重複をどう扱うか

フィールド種別の一覧は 5 箇所に書き下されている。
`Saved` の型 / `Editing` の型 / `VALUE_SHAPE` / ガード / 構築子。

**導出しない。**条件型で `Editing` を `Saved` から作れば重複は消えるが、
ホバー表示とエラーメッセージが読めなくなる。
kintone-typeguard が `FFF<A, B, C, D>` でそれをやって失敗した道。
このライブラリの利用者はプラグイン開発者で、
型を読んで挙動を理解できることが利得の中心にある。

代わりに **ずれたら落ちる仕掛け**を置く。
`test/fieldTypes.ts` の `OBSERVED_FIELD_TYPES` を軸に 3 方向を突き合わせる。

| 突き合わせ | どこ | 落ちる条件 |
| --- | --- | --- |
| 一覧 ↔ フィクスチャ | `test/coverage.test.ts` | 実測に現れた種別が一覧に無い / 一覧にあるのに観測されていない |
| 一覧 ↔ 型 | `test/coverage.test-d.ts` | `Saved.OneOf` / `Editing.OneOf` が一覧と一致しない |
| 一覧 ↔ 実装 | `test/coverage.test.ts` | `VALUE_SHAPE` / ガード / 構築子に漏れがある |

kintone に種別が増えたときは、フィクスチャを採り直す → 一覧が落ちる →
一覧に足す → 型と実装が落ちる、の順に必ず気づける。
変異テストで 3 方向とも実際に落ちることを確認済み。

重複を許す代わりに、**気づかないまま放置されることを許さない**という取り引き。

## 公開 API の型を推論に委ねない

`field.subtableRow` の戻り値は推論に任せていた。
その結果 `.d.ts` に出る型が **式の書き方に依存**していた。

```ts
) => (id === undefined ? { value } : { id, value })   // → { value: T } | { id: string; value: T }
) =>
	id === undefined ? { value } : { id, value }      // → { value: T; id?: never } | ...
```

前者だと `row.id` が読めない。TypeScript 7 へ上げたときに発覚した。

`.d.ts` の生成は型推論とは別処理で、推論結果を保てるとは限らない。
**外に出る型は明示する**。

### src のテストでは捕まらない

このとき src に対する `tsc` も vitest の型テストも全て通っていた。
壊れるのはパッケージを入れた利用者側だけ。

そこで `test/dist/consumer.ts` を置き、`pnpm run build` の最後
（`build:check`）でビルド成果物を利用者と同じ立場から型検査する。
修正前のソースで実際に落ちることを確認済み。

## グローバル型の拡張を import の副作用にしない

`tsumekae` を import してもグローバルは変わらない。
有効にするには `tsumekae/kintone` を明示的に import する。

**理由**: `toRestWrite` / `field.*` は rest-api-client と組み合わせて
サーバサイドでも使える。そこで `kintone` グローバルが生えていると
`kintone.events.on(...)` がコンパイルを通り、実行時に落ちる。
**存在しないものを型が保証する**状態で、このライブラリの目的と正反対。

**エントリ名を `kintone` にした理由**: 調べた範囲で `globals` という名前を
使っているパッケージは無かった。実際の慣行は「動く場所」（`vite/client`）、
「何をするか」（`dotenv/config`）、「宣言する対象」（`@kintone/dts-gen/kintone.d.ts`）
のいずれかで、仕組みで名付けている例が無い。
宣言する対象を名前にすると、dts-gen からの移行差分もそのまま読める。

**実行時ファイルが必要**: 副作用 import なので、型だけの exports エントリだと
`ERR_PACKAGE_PATH_NOT_EXPORTED` になる（検証済み）。
`dist/kintone.js` は空だが出力する。

**dts-gen との共存**: `events.on` と `record.get` の両方で確認済み。
ただし **`include` の順に関わらない、というのは間違いだった**（次節）。

## 名前空間のマージは順序で勝敗が変わり、診断が出ない

**2026-09-08。** README にこう書いていた。

> `tsconfig` の `include` の順に関わらず、こちらの型が優先されることを確認済み

**成り立たない。** `dist/kintone.d.ts` を、`get(): any` を持つ自前 ambient と
突き合わせると、`tsconfig` の `files` の並びだけで勝敗が入れ替わる。

```
files: ["own-any.d.ts", "probe.ts"]   → tsumekae が勝つ（TS2339 が出る）
files: ["probe.ts", "own-any.d.ts"]   → 自前の any が勝つ（診断ゼロ）
```

同じ名前空間はマージされ、同名の関数は**オーバーロードとして併存**する。
呼び出しは先に宣言された側から解決されるので、先勝ちになる。
`Duplicate identifier` は出ない。**どちらが勝ったかを教える診断が一つも無い。**

元の確認が間違っていたのではなく、**条件を落として一般化していた**。
確かめた相手は `@kintone/dts-gen` で、あれは `types` 経由のルート `.d.ts` として
先に読まれるので順序が固定される。その特殊な条件での結果を、
「順に関わらず」と書いていた。**一度の確認を、確かめていない範囲まで広げていた。**

**決定**: 自前の `kintone.d.ts` を持つプロジェクトには
`tsumekae/kintone` を使わせない。向きを逆にして、
利用者の `declare global` の中で `EditingRecord` / `SetRecord` / `EventOf` を参照させる。
マージが起きないので順序に依存しない。

そのために `SetRecord` をルートから export する。
`kintone.app.record.set()` の引数の型は
`tsumekae/kintone` の中のグローバル型としてしか存在せず、
**ルートからは取れなかった**。導入先で最多の語彙が `Set` 系
（`kintoneRecordFieldSet` 92 箇所）なので、ここが塞がっていると併用できない。

**エントリを分ける案は採らない。** ぶつかるのは
`kintone.app.record.get` という宣言箇所そのものなので、
`tsumekae/kintone-record` を作っても同じことが起きる。

順序を入れ替えた 2 通りを `pack:check` のシナリオとして固定した。
**「自前の any が黙って勝つ」ほうも、その結果を期待値として書いている。**
望ましくない挙動だが、いま実際にそうなっている以上、
変わったときに気づけるようにしておく。

## 「通ること」しか見ない検査は any を捕まえられない

**2026-09-08。** 上のシナリオを書いていて見つけた。

`pack:check` は前から `bundler` と `nodenext` の両方を検査していたが、
**`nodenext` の検査は最初から素通りだった。**

`dist/*.d.ts` の相対 import に拡張子が無かった（14 種類）。

```
dist/kintone.d.ts(1,48): error TS2834: Relative import paths need explicit
file extensions in ECMAScript imports when '--moduleResolution' is 'nodenext'.
```

このエラーは **`skipLibCheck: true` では出ない**。TypeScript の既定なので、
利用者はまず出さない。解決に失敗した型は `any` になり、
`kintone.app.record.get().record.存在しないプロパティ` が通る。

**`Rest` の委譲をやめた理由がこれ**（Q7「委譲は『検出できない `any`』と引き換えだった」）。
利用者が `@kintone/rest-api-client` を入れていないと型が `any` に落ちる、
という理由で自前に切り出したのに、**同じ穴を自分で踏んでいた。**

**なぜ気づけなかったか。** `pack:check` の利用者コードは
「コンパイルが通るか」だけを見ていた。`any` は何を書いても通る。
**全部が `any` に落ちた状態と、全部が正しく付いている状態が、同じ緑になる。**

**決定**: 3 つ入れる。

| | |
|---|---|
| `src` の相対 import に `.js` を付ける（61 箇所） | `bundler` でも `nodenext` でも解決できる書き方 |
| `tsconfig.build.json` を `nodenext` で出す | 拡張子が無ければ**書いた時点で落ちる**。`tsc --noEmit`（`bundler`）は捕まえられない |
| `pack:check` に `skipLibCheck: false` のシナリオを足す | `dist/*.d.ts` そのものを検査対象にする |

**「エラーが出ること」を期待するシナリオが 1 つも無かった**のが根本で、
今回の「併用: 自前 ambient が先」（TS2339 を期待）がその役も兼ねる。
`dist` の解決が壊れれば、期待した診断が出なくなって落ちる。

## dist を掃除せずにビルドしていた

**2026-09-08。** 同じ流れで見つけた。`build` が `dist` を消していなかったので、
消したソースの成果物が残っていた（`dist/rest.d.ts` / `dist/__broken.d.ts`）。

CI は clean checkout なので**公開物には入っていない**。
問題は逆で、**手元の `pack:check` が CI と違うものを検査していた**こと。
`files: ["dist"]` なのでローカルで `pnpm pack` すれば残骸ごと入る。

`build:clean` を足して `build` の先頭に置いた。

## 採取文脈の下限を固定する

型の主張の中には、**特定の採取が存在すること**に依存しているものがある。
ところが既存のテストの多くは全称型で、サンプルが減っても素通りで通る。

`disabled` / `error` が読み取りに存在しないという主張の根拠は
`screen.*.afterSet` の 2 サンプルだけだが、これを採り忘れても
「どのサンプルにも disabled は無い」は通る。
**テストは全部緑のまま根拠だけが消える**。

`test/contexts.ts` の `REQUIRED_CONTEXTS` が、採取が満たすべき下限を定める。
各項目は「この採取が無いと、どの主張の根拠が消えるか」を持つ。
`OBSERVED_FIELD_TYPES` がフィールド種別に対してやっていることを、採取文脈に対してやる。

change イベントだけは接頭辞で要求する。イベント名に埋まるフィールドコードは
採取スクリプトの都合で決まるもので、kintone の仕様ではないため。
ただしサブテーブルの change は `changes.row` が null にならない唯一のケースなので
コードまで指定する（テーブルのコードは `fields.ts` で我々が決めている）。

## 採取ハンドラの多重登録

上の測定で編集画面のカウントが 2 になったのは、set() が 2 回発火したのではなく
**ハンドラが 2 回登録されていた**ため（記録された 2 件は data も envelope も完全一致）。

`boot` は detail.show / edit.show など画面イベントごとに走る。
kintone は詳細→編集をページ再読み込みなしで遷移するので、
遷移のたびに change ハンドラが増えていた。

凍結フィクスチャにも同じ重複がある（`edit.change` の件数が 8 / 4 / 4 / 2 / 2 と全て偶数）。
同一データなので型の導出は誤っていないが、当時の実測レポートの `n` を水増ししていた。

**e2e では致命的**になる。「操作を固定すれば同じ結果」という前提が、
画面遷移の経路によって崩れるため。登録呼び出しを 1 つのプロミスに畳んで修正した。
真偽値のフラグでは `getFieldCodes` の待ち時間に 2 回目が通過するので足りない。

## 実測の根拠を e2e 採取に置き換えた

**2026-08-30。** 手動で採った 84 サンプルを捨て、e2e が採った 26 サンプルを根拠にした。

**理由**: 再現できない根拠は、検証できない根拠。
手動フィクスチャは採取ツールのバグで 2 サンプルが誤ラベルされ、
除外するための使い捨てスクリプト（`tools/fixture/clean.ts`）を
書く必要があった。**そのスクリプトは 2026-09-11 に消した**
（一度きりの用途で、どの `package.json` のスクリプトからも呼ばれておらず、
しかも `setBehavior` を落として書き出す形のまま残っていた）。
あのまま型を起こしていたら「詳細画面の値は undefined になりうる」という誤った型になっていた。

**e2e のほうが厳密だった証拠**: 手動フィクスチャには
`changes.row` が非 null のサンプルが **1 件も無かった**。
`ChangeEvent.row: Editing.SubtableRow | null` の非 null 側は、
実測の裏づけが無いまま型に書かれていた。

サンプル数は 84 → 26 に減ったが、`REQUIRED_CONTEXTS` は全て満たしており、
既存の 195 テストが全て通る。多いことより、何を含むかが決まっていることが重要。

## 採取結果は決定的である

**2 回の独立した実行がバイト単位で一致することを確認済み**（md5 も同一）。
別のレコード、別の時刻、別の fileKey にもかかわらず。

これが成立するのは 2 つの設計による。

1. **固定フロー**（レコード追加 → 詳細 → 編集 → 一覧 → 削除）。
   既存レコードを触らないので状態が累積的に汚れない。
   毎回まっさらなレコードから始まるので `$revision` は必ず 1 → 2 になり、
   正規化の対象にしなくてよい。ずれたら本物の信号になる
2. **正規化層**（`tools/fixture/normalize.ts`）。実行ごと・環境ごとに変わる値だけを伏せる

値そのものは潰さない。kintone の更新で日時フォーマットが変わるような
**値の変化こそ検出したい**ため。伏せるのは列挙したものだけ。

### 正規化で踏んだこと

- **フィールドコードではなく `type` で判定する**。「レコード番号」「作成日時」は
  環境の言語で変わるが `RECORD_NUMBER` / `CREATED_TIME` は変わらない
- **空文字は伏せない**。`""` と非空の区別は DROP_DOWN の型を決めた根拠で、
  潰すと `"" | string` が `string` になって型が変わる
- **`changes.row` の行 id が漏れていた**。SUBTABLE 配下の行は拾えていたが、
  `changes.row` は `type` を持たない裸のオブジェクトなので経路から外れていた。
  2 回の採取で id だけが 47 と 49 に食い違って発覚した
- **probe 自身が `Date.now()` を書き込んでいた**。こちらが毎回違う値を書くと
  本物の変化が埋もれる。画面名を混ぜた決定的な値に変えた
  （同じ値の再設定では change が飛ばないため、画面ごとに変える必要がある）

## 採取カスタマイズの適用は CI から行わない

`updateAppCustomize` には **kintone のシステム管理権限**が要る（公式ドキュメント）。
アプリ管理権限だけでは足りない。実際に CI で `403 CB_NO02` を踏んで判明した。

| API | 必要な権限 |
| --- | --- |
| `updateAppCustomize`（書き込み） | **システム管理権限** + アプリ管理権限 |
| `getAppCustomize`（読み取り） | アプリ管理権限のみ |

システム管理権限は組織全体に効くので、
**「権限を検証アプリ 2 つに限定する」という方針（Q9）が成立しない**。
しかもこれは「アプリに任意の JS を仕込める」権限で、CI に置くと
main にマージされたコードが組織内の任意のアプリに JS を仕込めることになる。
得るもの（貼り直しの自動化）に対して代償が大きすぎる。

**probe.js は変わらない限り貼り直す必要がない。**
適用は probe を変えたときに人がローカルから行い、
定期ジョブは**貼られているものが手元のビルドと同一かを確認するだけ**にする
（`tools/fixture-app/checkProbe.ts`）。読み取りなのでアプリ管理権限で足りる。

確認はサイズではなく**配信されている実物をダウンロードしてハッシュで比べる**。
サイズが同じで中身が違う変更を見逃さないため。
古い probe で採った結果を「kintone が変わった」と誤認するのが最悪の失敗なので、ここは厳密にする。

取りこぼす risk は「probe.js を変えたのに貼り直し忘れる」だが、
それはこの確認が検出して適用コマンドを案内する。
確認を入れる前のほうが危険だった（古い probe のまま採取が進む）。

## 適用の失敗は kintone 由来のことがある

手元での適用（`pnpm run app:deploy-probe`）で
kintone が一過性の 500（`GAIA_CS02`「予期せぬエラーが発生しました」）を返すことがある。実際に踏んだ。

そのとき適用が中途半端に終わり、続く採取が「パネルが出ない」で失敗する。
症状が「カスタマイズが動いていない」なので原因が分かりにくい。
適用が失敗したら、成功するまで繰り返すこと。

## 参照

- 実測の手順: [`../CONTRIBUTING.md`](../CONTRIBUTING.md)
- 実測データ: [`../fixtures/measured.json`](../fixtures/measured.json)（e2e が採り、`pnpm run fixture:build` が正規化する）
- REST 書き込みの受け入れ挙動: [`../fixtures/write-behavior.md`](../fixtures/write-behavior.md)
- 採取シリアライザとその不変条件: `src/probe/serialize.ts` / `src/probe/serialize.test.ts`
- 検証アプリのフィールド定義: `tools/fixture-app/fields.ts`

## ガードのテストをフィールドコードで書かない

**2026-09-08。** `src/guard/record.test.ts` はこう書いていた。

```ts
const target = records.find(({ record }) => isSubtable(record.subtable));
```

`subtable` は `tools/fixture-app/fields.ts` で**我々が決めた**コードで、
kintone の仕様ではない。実アプリのサブテーブルがこの名前であることは、まず無い。

**ガードの主張は「`type` が一致するものに絞り込める」で、コードは関係が無い。**
コードで引くと 3 つ壊れる。

- 主張と関係のないものを検査している
- 1 件見つけた時点で緑になり、他が絞り込めなくても気づけない
- 落ちたときの意味が「ガードが壊れた」ではなく「コードが変わった」になる

**どれくらい効いていなかったか。** 実装を 2 通り壊して旧テストを回した。

| 壊し方 | 旧テスト | 新テスト |
|---|---|---|
| `isFile` が `FILE` を見なくなる | **6 passed（緑）** | 落ちる |
| `isSubtable` が常に `true` を返す | **6 passed（緑）** | 落ちる |

ガードが**全部の判定を間違えていても緑**だった。

「採取文脈の下限を固定する」では、コードまで指定してよいのは
**他に特定する手段が無いとき**だけ、としている
（サブテーブルの change は `changes.row` が null にならない唯一のケース）。
ここは `type` で引けるので、その条件を満たしていなかった。
**基準はあったが、照らしていなかった。**

**決定**: `type` で集めて、その集合すべてに対して
「取りこぼしゼロ」と「他種別の混入ゼロ」の両方を見る。
サブテーブルの中も歩く（`FILE` は行の中にも入る）。

`isLookup` の `expect([...codes]).toEqual(["lookupKey"])` は残す。
ここは**主張がコードの集合そのもの**だから。
キーフィールドの `type` は元フィールドの型になるので `type` では区別できず、
コピー先と区別できることを示すには「どのコードが検出されたか」を見るしかない。

## kintone グローバルは公式一覧の 166 個すべてを宣言する

**2026-09-08。** それまで `tsumekae/kintone` は **9 個**しか宣言していなかった。

| | 宣言している数 |
|---|--:|
| 公式ドキュメント | 166 |
| `@kintone/dts-gen` 9.0.8 | 51（31%） |
| `tsumekae/kintone`（当時） | **9（5%）** |

`kintone.app.getId()` も `kintone.api()` も `getLoginUser()` も
`plugin.app.getConfig()` も無い。**実プラグインは 1 つも書けない。**

必ず dts-gen か自前の宣言を併せて入れることになり、
入れた瞬間に名前空間がマージされて順序依存に入る。
つまり「レコード周りだけ差し替える」という設計そのものが、
**併用を強制することで自分の首を絞めていた**。

dts-gen の 51 個は公式一覧の**真部分集合**（差分ゼロを機械的に確認）。
166 個を書けば dts-gen は要らない。

**決定**: 公式ドキュメント（https://cybozu.dev/ja/kintone/docs/js-api/）の
166 個すべてを 1 ファイルに宣言する。1 ファイルに閉じるので、
マージが起きず順序依存も無い。

`test/jsApi.ts` の `OFFICIAL_JS_APIS` が一覧を持ち、
`test/jsApi.test.ts` が `src/kintone.ts` の宣言と突き合わせる。
**足りない側と余っている側の両方**で落ちることを確認した。
dts-gen の 51 個を含むことも別に確かめている（狭くなったら意味が無いので）。

## dts-gen を土台にしない

**2026-09-08。** `/// <reference types="@kintone/dts-gen/kintone" />` で
dts-gen を読み込み、レコード周りだけ上書きする案を試して捨てた。

参照が**自分のファイルの中**にあるので、順序は自分で決められる。
名前空間のマージは後勝ちなので、`get()` は tsumekae が勝つ。ここまでは狙いどおり。

**引数の位置で全部漏れた。**

```ts
kintone.app.record.set({ でたらめ: 1 });                   // 通る
kintone.app.record.set("まったくの文字列");                 // 通る
kintone.events.on("app.record.detail.show",
  (event: { でたらめ: string }) => event);                 // 通る
kintone.events.on("app.record.detial.show", (e) => e);    // タイポも通る
```

戻り値は先頭のオーバーロードが選ばれるので厳しいほうが勝つ。
引数は**「どれか 1 つが通れば通る」**ので、
`set(record: any)` が 1 つ混ざるだけで検査が消える。

**「読みは厳しく、書きは無検査」という一番まずい状態になる。**
`set()` は導入先で最多の語彙（92 箇所）なので、ここが緩いと導入する意味が無い。

依存として入れる案も採らない。dts-gen は CLI パッケージで
`axios` / `lodash` / `commander` / `form-data` / `eslint` / `prettier` を持つ。
加えて導入先（kintone-plugins）は TypeScript 7 のために dts-gen を捨てており、
tsumekae 経由で戻すことになる。

引き写す案も採らない。51 個は 166 個の真部分集合なので、
**書けば要らなくなる**。MIT の著作権表示を持ち回る理由が無い。

## 実測とドキュメントを混ぜない

166 個のうち、**実測が根拠なのは 4 個だけ**
（`events.on` / `events.off` の event と `app.record.get` / `set` のレコード、
およびモバイルの同等品）。残りは公式ドキュメントを読んで書いた。

CLAUDE.md の最優先原則は「型に書く前に測る」で、これと衝突する。
折り合いの付け方はこう決めた。

**測っていないものを、測ったふりで書かない。**

- ドキュメント由来の値の型は `src/types/jsApi.ts` の `Api` 名前空間に分ける
- ファイル冒頭に「実測ではない」と書く
- `src/kintone.ts` の各宣言に、どちらが根拠かを書く

ファイルが分かれていると、型を直すときの手順も分かれる。
**実測なら採り直す。ドキュメントなら読み直す。**
混ざっていると、どちらをすべきか判断できない。

`src/index.ts` に既にあった「実測の裏づけが無いものは JSDoc に明記してある」
という方針を、名前空間の分割まで押し上げたもの。

### ドキュメントと dts-gen が食い違っている箇所

`getLookupTargetAppId` / `getRelatedRecordsTargetAppId` の戻り値。

| | |
|---|---|
| 公式ドキュメント | 「型: 数値」 |
| `@kintone/dts-gen` | `string \| null` |

**ドキュメントに従った。** 実測すれば決着するが、
今回は「レコード以外は実測しない」と決めているので、
どちらが正しいかは**確かめていない**。ここに書いておく。

移行するときは、この 2 つだけ `Number()` / `String()` の扱いが変わり得る。

## 要素の型は Element ではなく HTMLElement

ドキュメントは「要素」としか書いていない。`Element` のほうが忠実だが、
`HTMLElement` にした。

dts-gen が `HTMLElement` を返しており、既存のカスタマイズは
`.style` や `.appendChild` を直接触っている。
`Element` に広げると**その呼び出しが全部落ちる**。
移行のたびに `as HTMLElement` を書かせることになり、
`as` を減らすというこのライブラリの目的と正反対になる。

## 手で作ったオブジェクトは「他種別の混入」を捕まえられない

**2026-09-08。** ガードのテストからフィールドコードを外した（前節）が、
**実測データを通しているのは 28 種別のうち 2 つだけ**だった
（`isSubtable` / `isFile`）。残り 26 は
`test/coverage.test.ts` の「ガードが全種別にある」だけが見ている。

そちらは**手で作ったオブジェクト**を通す。

```ts
expect(is({ type, value: undefined })).toBe(true);
expect(is({ type: "他の型", value: undefined })).toBe(false);
```

これで捕まる壊し方と、捕まらない壊し方がある。

| 壊し方 | 手作りオブジェクト | 実測データ |
|---|---|---|
| 常に `true` を返す | 落ちる | 落ちる |
| 常に `false` を返す | 落ちる | 落ちる |
| 別の `type` を見る（`FILE` → `FILE_X`） | 落ちる | 落ちる |
| **実在する別の種別を 1 つだけ通す** | **緑のまま** | 落ちる |

最後のものが穴だった。

```ts
export const isNumber = (f) => f.type === "NUMBER" || f.type === "CALC";
```

`is({ type: "他の型" })` は `CALC` ではないので `false` のまま返る。
**テストが用意する「他の型」が、実在する種別を 1 つも含んでいない。**

**どれくらい効いていなかったか。** 21 種別でこの壊し方を試した。

| | |
|---|--:|
| 落ちた | 2（`isSubtable` / `isFile` = 実測データを通していたもの） |
| **緑のまま通った** | **19** |

`isCalc` が `NUMBER` を通す、`isDate` が `DATETIME` を通す、
`isCreator` が `MODIFIER` を通す ── いずれも気づけない。
**利用者が最も踏みやすい壊れ方**でもある（似た種別ほど混ざる）。

**決定**: 実測データによる両方向の検査を、**全 28 種別**に広げる。

- その `type` の実測フィールドを**すべて**通す（取りこぼしゼロ）
- その `type` **以外**を 1 つも通さない（混入ゼロ）

`type` からガード名を機械的に引く（`test/coverage.test.ts` と同じ対応表）。
21 種別すべてで落ちるようになったことを確認した。

`test/coverage.test.ts` のほうは残す。あちらは
**ガードが存在すること**を 28 種別に対して縛るもので、
実装を消したときに落ちる役割が違う。

## 変換テストも type で引く

同じ理由で `src/convert/toRestWrite.test.ts` のサブテーブル関連も直した。
`record.subtable` と `t_calc` を直接書いていたが、どちらも
`tools/fixture-app/fields.ts` で我々が決めたコードで、kintone の仕様ではない。

`type === "SUBTABLE"` でテーブルを探し、行の中も
`type === "CALC"` で探して**コードは実測データから取り出す**。

「テーブル内の CALC は落とされる」だけだと**全部落とす実装でも通る**ので、
「CALC 以外は残る」を対で足した。
片方向だけの主張はこの形で裏返せることが多い。

4 通り壊して確認した（落とす処理を消す / 全部落とす / 行 id を捨てる /
null の行にも id を付ける）。すべて落ちる。

## biome の警告で check が落ちていなかった

**2026-09-08。** `pnpm run check` は「これがすべて」なのに、
`biome check .` は**警告を出しても exit 0** で返る。

死んだ関数（前のリファクタで参照だけ消して定義を残したもの）が
`noUnusedVariables` に引っかかっていたが、**CI も手元も緑のまま**だった。

```
Found 1 warning.
exit=0
```

このルールは `recommended` に入っていて有効。既定の重大度が `warn` なだけ。
**「有効になっている」と「落ちる」は別**だった。

`--error-on-warnings` を足した。入れた直後に、
別ファイルの未使用 import を 1 件すぐ捕まえた。

## ガードの表を名前から導出しない

**2026-09-08。** 全 28 種別を実測データで縛るテストで、
`type` からガード名を文字列操作で導出していた。

```ts
const toGuardName = (type) => `is${camelCase(type)}`;
const fn = (guards as { [key: string]: unknown })[toGuardName(type)];
```

**このリポジトリの方針に反している。** 型 / `VALUE_SHAPE` / ガード / 構築子は
全 28 種別を書き下している（Q3）。テストだけ導出する理由が無い。

実害もある。

| | 導出 | 表（`Record<ObservedFieldType, ...>`） |
|---|---|---|
| ガードを 1 つ消す | 実行するまで気づけない | **tsc が落ちる** |
| 種別を足して書き忘れる | 実行するまで気づけない | **tsc が落ちる** |
| 例外の対応表 | 結局 4 件持っている | 表に吸収される |

`guards[name]` はインデックスアクセスなので
`{ [key: string]: unknown }` へのキャストが要り、**型検査が丸ごと消える**。
`test/guards.ts` の `GUARD_OF` に置き換えた。両方とも tsc で落ちることを確認した。

`test/coverage.test.ts` にあった同じ導出も消して、同じ表を使う。
役割は分けたまま。

| | |
|---|---|
| `test/coverage.test.ts` | 関数が在って `type` で判別すること（消したら落ちる） |
| `src/guard/record.test.ts` | 実測データを取りこぼさず、他種別を混入させないこと |

### 「表を作る」と「エクスポートから拾う」の使い分け

`src/guard/guard.test-d.ts` の型テストは、逆に**表を持たずに**
`keyof typeof guards` で全ガードを拾っている。矛盾ではない。

| | やり方 | 理由 |
|---|---|---|
| `type` からガードを引く（実行時） | **表**（`GUARD_OF`） | 種別が軸。名前を文字列操作で作ると型検査が消える |
| ガードを全部数える（型レベル） | **エクスポートから拾う** | ガードが軸。`keyof typeof` は型安全で、足せば自動で対象になる |

分かれ目は**文字列を組み立てるかどうか**。
`is${camelCase(type)}` は型の外での組み立てで、外れても分からない。
`keyof typeof guards` は組み立てていないので外れようがない。

`isLookup` と `hasValue` は表に入れない。**`type` で判定していない**ため。
ルックアップのキーフィールドの `type` は元フィールドの型そのもので、
通常のフィールドと区別がつかない（`confirmed` / `recordId` の有無で見る）。
`hasValue` は `value !== undefined` で、種別に紐づかない。
種別ごとの検査の対象にならないので個別にテストする。

## 緩いレコードでガードが value を絞っていなかった

**2026-09-08。** `LooseRecord` から引いたフィールドをガードに通しても、
`value` が `unknown` のまま残っていた。

```ts
declare const record: LooseRecord;
const table = record[code];
if (isSubtable(table)) table.value.length;   // TS18046: 'unknown'
```

`Narrow` の緩い入力向けの分岐が `T & { type: Type }` で、
**`type` しか絞っていなかった**ため。

`LooseRecord` は「変換・代入・ガードの入力型。自前のヘルパを書くときに
同じ骨格を再定義しなくて済むよう公開する」としているのに、
**そこでガードが効かないなら公開した意味が無い**。

`Saved` / `Editing` / `Rest` から引いた場合は `Extract` が効くので問題なかった。
穴は緩い入力のときだけ。

**決定**: `InAnyContext<Type>`（3 文脈のうちその `type` を持つもの）と
交差させて `value` まで絞る。`unknown & FileInformation[]` は
`FileInformation[]` になるので、3 文脈の value の union が残る。

### 型テストが弱くて気づけなかった

この経路の型テストは**存在していた**。主張が弱かった。

```ts
if (isSubtable(f)) {
  expectTypeOf(f.value).not.toBeNever();   // unknown は never ではないので通る
}
```

`not.toBeNever()` は「絞り込みが壊れて never になっていないか」しか見ない。
**`unknown` のまま素通りしていることは検出できない。**

`toEqualTypeOf<string | undefined>()` のように**何に絞られるか**を書き、
`f.value.trim()` のような**実際の使い方**も置いた。
`Narrow` を元に戻すと 2 件落ちることを確認した。

`not.toBeXxx()` 系の主張は、この種の「弱いまま通る」を作りやすい。

### 3 文脈を 1 つに畳めるか測った → 畳めない

union の表示が長くなるので、最も広い 1 つに畳めないかを確かめた。

| | |
|---|---|
| `Saved` は `Editing` に代入できる | **できる** |
| `Rest` は `Editing` に代入できる | **できない** |

`Rest` が外れるのはサブテーブルで、`SubtableRow` の `id` が
`Rest` では `string`、`Editing` では `string \| null`、
さらに行の中身（`InSubtable`）の union も違うため。

畳めないので 3 つとも残す。代償として、種別を間違えたときのエラーが

```
Type 'SubtableRow<...>[] | SubtableRow<...>[] | SubtableRow<...>[]'
  is not assignable to type 'string'.
```

のように同じ形の重複を含む。2 行目は読めるので許容する。
`Saved` は `Editing` の部分型なので落とせなくもないが、
その関係が保たれることを別に縛る必要が出るので、
**表示のためだけに不変条件を増やさない**。

## undefined が付くかは画面ではなく取り方で決まる

**2026-09-08。** 「編集画面なら `value` は `string` だけで `undefined` にならないのでは」
という問いを受けて、フィクスチャを数え直した。**画面では決まらない。**

| 取り方（PC 編集画面） | `value` が undefined |
|---|--:|
| `app.record.edit.show` の `event.record` | **0 / 54** |
| `kintone.app.record.get()` | **21 / 54** |
| `app.record.edit.change.*` の `event.record` | 20〜28 / 54〜71 |
| `app.record.edit.submit` の `event.record` | 21 / 54 |
| `app.record.edit.submit.success` の `event.record` | **0 / 54** |
| REST の `getRecord` | **0 / 54** |

同じ画面の同じレコードでも、`edit.show` の `event.record` と
`kintone.app.record.get()` で違う。
前者はサーバから来たもの、後者は編集中のフォームの状態を返すため。

型は既にこのとおりに分かれていた（`edit.show` → `SavedRecord`、
`get()` → `EditingRecord`）ので**修正は無い**。README に表を足した。

「編集画面だから」「詳細画面だから」で推測すると外れる、という
このリポジトリの主張のもう一つの実例。

## 型テストの主張が弱いと素通りする

**2026-09-08。** 続けて 2 件見つかった。どちらも
**テストは在るのに、主張が弱くて壊れても緑**というもの。

| 主張 | 何を見逃すか |
|---|---|
| `expectTypeOf(f.value).not.toBeNever()` | `unknown` のまま残っていても通る |
| `Extract<U, { disabled: unknown }>` が never | **optional** で生えた `disabled?:` を通す |

2 つ目は制御した例で測った。

| | `disabled?: boolean`（optional） | `disabled: boolean`（必須） |
|---|---|---|
| `Extract<U, { disabled: unknown }>` | **拾えない** | 拾える |
| `K extends keyof U` で見る | 拾える | 拾える |

`@kintone/dts-gen` の `fieldTypes` は **optional で** `disabled?` / `error?` を持つ。
引き写しが混入したときに拾えないと意味が無いので、`keyof` で見る形にした。
`Saved.Link` に両方の形で生やして、どちらも落ちることを確認した。

### 変異が当たっていないのに結論を出しかけた

この 2 つ目を調べる過程で、`field.ts` に仕込んだつもりの変異が
**一度も当たっていなかった**（`Time` の実際の定義は `FieldOf<"TIME", string | null>`
で、`FieldOf<"TIME", string>` を探していた）。
それに気づかず「`Extract` は optional を素通りする」と結論しかけた。
結論自体は別の測り直しで正しかったが、**根拠は無効だった**。

変異テストは「落ちなかった」を根拠にするので、
**仕込みが当たったことを先に確かめないと、何も測っていないのと同じになる**。
以後、変異を入れたら適用結果を表示してから走らせる。

## kintone-typeguard のテストから採ったもの

依頼元のリポジトリ（`cy-takeuchi/kintone-typeguard`）の
`src/test/vitest/typeguard.test.ts` を読んで、取り入れたものと採らなかったものを残す。

**採った**

- `@ts-expect-error` で「**通ってはいけない**」ことを主張する
  （`field.value[0].disabled` が生えていないこと）。
  こちらは 11 箇所で既に使っていたが、`disabled` / `error` は
  `Saved.SingleLineText` の 1 種別しか縛っていなかった。union 全体に広げた
- ガードで絞った先の型を `expectTypeOf` で確かめる。
  向こうは種別を数個書いているが、こちらは**全ガードを総当たり**にした
  （エクスポートから型述語を拾うので、ガードを足せば自動で対象になる）

**採らなかった**

- **実 kintone に接続するユニットテスト。** 向こうは `beforeAll` でアプリを作り、
  REST でレコードを採ってから検証する。
  こちらは凍結したフィクスチャに対してだけ走らせ、実接続は
  e2e と週次のライブ検証に分けている（Q6）。
  認証情報なしで数秒で回せることを優先する
- **`guardFormField`（フォーム設定のガード）。** 守備範囲外。
  フォーム設定は実測の対象にしていない

## ルートは DOM に依存しない

**2026-09-08。** `Api.DialogConfig` の `body?: Element` と
`Api.ProxyUploadData` の `value: Blob` が **DOM の型を直接参照していた**。

ルート（`tsumekae`）から `Api` を出しているので、
`dist/types/jsApi.d.ts` がそれを参照する。
`lib` に DOM を入れていない利用者（AWS Lambda など）では

```
dist/types/jsApi.d.ts(287,16): error TS2304: Cannot find name 'Element'.
dist/types/jsApi.d.ts(311,16): error TS2304: Cannot find name 'Blob'.
```

となる。**`skipLibCheck: true`（TypeScript の既定）では出ない。**
出ない代わりに型が `any` に落ちる。
**`Rest` の委譲をやめた理由**（Q7）と同じ状態を、また自分で作っていた。

**決定**: `globalThis` に在るかで分岐する型にする。

```ts
export type DomElement = typeof globalThis extends {
	Element: abstract new (...args: never) => infer T;
} ? T : { readonly nodeType: number; readonly nodeName: string };
```

ブラウザでは本物の `Element`、Node では最小形になる。
最小形でも `document.createElement()` の戻りは構造的に代入できるので、
ブラウザ側の書き味は変わらない。

**型を隠す案は採らなかった。** `DialogConfig` を `tsumekae/kintone` 側に
移せばルートは DOM から切れるが、
自前ヘルパの引数に使いたい利用者がサブパスを import することになる。
`createDialog` はブラウザ専用 API だが、**その型を扱うコードは Node でも書ける**
（設定オブジェクトを組み立てて渡すだけの層など）。

検査は `pack:check` の「Node（AWS SAM 相当）」シナリオ。
`lib: ["ES2022"]`（DOM 無し）かつ `skipLibCheck: false` で、
`tsumekae/kintone` を import しない利用者を通す。
`Element` を直接書く形に戻すと TS2304 で落ちることを確認した。

## フォーム定義は守備範囲に入れない

**2026-09-08。** `kintone-typeguard` を閉じるにあたって、
その `guardFormField`（29 個）と `guardFormLayout`（29 個）を
tsumekae が引き取るべきかを検討した。**引き取らない。**

**別の対象を判別している。** こちらは `getFormFields` / `getFormLayout` が返す
**フォームの設定**で、レコードの値ではない。`value` が無いので、
tsumekae のガードは引数の時点で受け取れない（実際に試した）。

```
error TS2345: Argument of type 'OneOf' is not assignable to parameter of
type 'LooseField | null | undefined'.
  Property 'value' is missing in type 'Calc' but required in type 'LooseField'.
```

**種別の集合も違う。** tsumekae は `GROUP` と `REFERENCE_TABLE` を
「レコードには現れない」と**実測で確かめて除外**している。
フォーム定義にはどちらも存在し、さらに `LABEL` / `SPACER` / `HR` という
フィールドですらないレイアウト要素がある。
28 種別という軸そのものが噛み合わない。

**実測の価値が薄い。** レコードの値は JS API / event / REST の 3 経路で形が違い、
それを測ることに意味があった。フォーム定義は設定 API が返すもの 1 経路しかない。
測っても「ドキュメントどおりだった」以上のものが出にくい。

引き取るなら型を 33 種別以上、採取をフォーム設定まで拡張、
という作業が要るが、**それは別のパッケージの仕事**。
`Api.FormField` はルートから出しているが、共通部分だけの緩い型に留める。

> **2026-09-10 追記: その「別のパッケージ」を作ることにした。**
> `kisekae`（`kintone-pretty-fields` の作り直し）が引き取る。
> この節の結論は変わらない ── tsumekae はフォーム定義を守備範囲に入れない。
>
> ただし**検証アプリは共有する**。フォーム定義を測る対象は、
> tsumekae がすでに建てた検証アプリそのもので、二重に建てる理由がない。
> そのため `tools/fixture-app/layout.ts` に `SPACER` / `LABEL` / `HR` を足した
> （[フォーム定義を測れる状態にする](#フォーム定義を測れる状態にする)）。
> これらはレコードに現れないので tsumekae の実測には影響しない。
>
> 実測データの所有は分ける。レコードの実測は `fixtures/measured.json`、
> フォーム定義の実測は `fixtures/form/definition.json`。
> kisekae の設計判断は `packages/kisekae/docs/DECISIONS.md` に置く
> （モノレポ化したときの置き場所に最初から置く。移動を 2 度やらないため）。

## get() → set() の変換はまだ書けない

**2026-09-08。** `kintone-typeguard` の `guardUtils.converterGetToSet` に
相当するものが tsumekae に無い。Q8 の計画には `forJsSet` として書かれていたが、
実装されないまま残っていた。

**書けない理由は、測っていないから。**
`kintone.app.record.set()` が

- どの種別を拒否するか
- `FILE` の `value` を `{ fileKey }` だけに削る必要があるか

を実測していない。REST については `fixtures/write-behavior.md` に 20 ケースあるが、
**`set()` は別の API で、同じとは限らない**（`type` が必須である点だけは実測済み）。

`kintone-typeguard` の実装は読み取り専用フィールドを落としているが、
その根拠は書かれていない。**推測をそのまま引き写すことはしない。**

測る手順は既にある（`tools/probe-write/` と同じやり方で、
`set()` に対して 1 種別ずつ投げて結果を見る）。測ってから足す。

## set() の受け入れ挙動を測る仕掛けを先に作る（#14）

**2026-09-08。** `toSetRecord` を書くには
`kintone.app.record.set()` が何を拒否するかの実測が要る。
実測は実 kintone への操作を伴うので、**ケース定義と probe だけを先に作った**。
測る前にレビューできるようにするのが目的で、
「その確かめ方では答えが出ない」という手戻りを実測の前に見つけたい。

### REST 版と作りが違う理由

| | REST（`tools/probe-write/`） | set()（`src/probe/setCases.ts`） |
|---|---|---|
| 実行場所 | Node | **ブラウザのみ** |
| 呼び方 | 直接 | **ボタン経由**（`events.on` の中では動かない） |
| 結果の置き場 | md へ直接書き出し | localStorage → export → 正規化 → md |

`set()` はブラウザでしか動かないので、ケース定義が `src/probe/` に居る。

### set() の失敗は probe では検出できない（2026-09-08 に踏んだ）

最初は「例外が出たか」と「前後で値が変わったか」の 2 つを残す設計にした。
**それでは何も測れなかった。**

`set()` に不正な値を渡しても**例外は飛ばない**。
kintone が「カスタマイズ用の JavaScript の実行時にエラーが発生しました」を
画面に出すだけで、呼び出し元には何も返らない。

**この事実は `e2e/panel.ts` に既に書かれていた。**

> `set()` に不正な値を渡しても例外は飛ばず、この表示が出るだけ（実測）。
> 「例外が出ていない」を成功と見なすと、誤った実測がそのまま基準データになる。
> **実際それで「value を省くと静かに無視される」という誤った結論を出しかけた。**

同じ落とし穴に 2 回落ちた。**知らなかったのではなく、リポジトリ内の記録を
確かめずに設計した。** 段階 A（測る前にレビューできる形にする）を
わざわざ分けたのに、その中身が既知の事実と食い違っていた。

**決定**: 判定は e2e が行う。probe は「渡したもの」と「前後の値」だけを残し、
kintone がエラーを表示したかを Playwright が見て `errorShown` に書き戻す。

`runSetCase` に try/catch は**置かない**。置くと「捕まえられる」という
誤解が残る。`setCases.test.ts` がソースを読んで
try/catch が無いことを縛っている。

### 1 ケースずつ、間に画面を読み直す

**一度エラー表示が出ると後続の `set()` も失敗する。**
21 ケースを 1 回のクリックで回す設計だったので、
最初の失敗が残り全部を汚染して「どのケースが原因か」が分からなくなった。

しかも kintone のエラー文言は汎用で、**どのフィールドが原因かは出ない**。

```
An error occurred while running the JavaScript for customization of the app.
```

だから 1 ケースずつ、直前に編集画面を読み直してから走らせる。
**1 対 1 で対応づけられることが、この読み直しの目的**。

パネルのボタンは外した。1 ケースずつ画面を読み直すのは probe 側からはできず、
まとめて走らせるボタンを残すと**罠になる**。
e2e が `runSetCase(id)` を呼ぶ形にした。

`click()` も使わない。あれは「エラーが出ていないこと」を成功の条件にしていて、
**エラーを出させて測るこの用途では必ず落ちる**。

### page.once("dialog") は発火しないと武装したまま残る

**2026-09-08。** 段階 B の 2 回目で別の失敗が出た。

```
Error: dialog.accept: Cannot accept dialog which is already handled!
  at panel.ts:560   ← deleteRecord の中
```

`deleteRecord` は `page.once("dialog", …)` を登録してから削除ボタンを押す。
確認の出し方が画面で違い、**DOM のダイアログで済んだ画面では
`window.confirm` が出ない**ので、そのリスナーは**発火せず武装したまま残る**。

今までは後続でダイアログが出なかったので無害だった。
`set()` の測定で汚れた編集画面から離れるときに離脱確認が出て、
**登録から数十行離れた場所で初めて露出した**。

`page.once` は「1 回発火したら外れる」であって「1 回でスコープが終わる」ではない。

**決定**: 登録したら必ず外す。`try` / `finally` で挟む。

`measureSetBehavior` は 21 回遷移するので `once` では足りず、
期間中ずっと承認する `page.on` にして `finally` で外す。

`setCases.test.ts` が e2e のソースを読んで
**`page.on` / `page.once` の登録数と `page.off` の数が一致する**ことを縛る。
片方を消すと落ちることを確認した。

**私の変更が原因ではなく、潜在していたものを露出させた。**
それでも直すのはこちら側で、リスナーの寿命を登録側が持つ形にする。

### 判定が無い結果からは結論を出さない

`errorShown` が `undefined`（手で走らせた場合）は「判定なし」として、
受け入れとも拒否とも書かない。
`fixture:set-behavior` は全件が `undefined` なら**表を出さずに失敗する**。
「エラーが出なかった」と取り違えると、誤った結論が基準になる。

### 値の形が同じ種別は、まとめて測る

`type` から値の形が決まる（`VALUE_SHAPE`）。逆は決まらない。
28 種別が **7 形**しかないので、値だけでは区別できない組み合わせが多い。

| 形 | 種別数 | |
|---|--:|---|
| `string` | **14** | `"abc"` はこの 14 種別すべてで通る |
| `entityArray` | 4 | |
| `nullableString` | 3 | `DROP_DOWN` / `DATE` / `TIME` |
| `stringArray` | 3 | `CHECK_BOX` / `MULTI_SELECT` / `CATEGORY` |
| `entity` | 2 | `CREATOR` / `MODIFIER` |
| `fileArray` / `rows` | 各 1 | |

`["a"]` が `CHECK_BOX` と `MULTI_SELECT` の両方で通るのは**問題ではない**。
書き込む先の `type` はレコードが持っているので、値から種別を当てる場面が無い。
「構造から推測しない」という Q8 の判断と同じ話
（`disabled` を持たない UI レコードと REST レコードは完全に同形）。

**測るときも結論を出すときも、種別で区別する。形でまとめない。**

`nullableString` の 3 種別（`DROP_DOWN` / `DATE` / `TIME`）に `null` を渡すケースは
**3 つ置く**。1 つだけ測って残りを「同じ形だから同じだろう」で埋めるのが、
このリポジトリが繰り返し塞いできた誤り。

結論も種別ごとの表にする。`REJECTED_ON_WRITE` が種別の一覧であり、
`VALUE_SHAPE` が種別から形を引く表であるのと同じ向きで、
**形から種別へ戻る道は作らない**。

`setCases.test.ts` が「`null` を受け付ける種別すべてにケースがある」ことを縛る。
`canSetValue` を使うのは**対象の種別を数え上げるためだけ**で、
まとめるためではない。`VALUE_SHAPE` を export しないのは、
内部の表を公開 API にしないため。

### 前は 1 ケースごとに読み直す

前のケースの `set()` が画面を書き換えているので、
`before` はケースごとに `get()` し直す。
最初に 1 回だけ読むと 2 件目以降の `before` が実態とずれる。

途中で落ちても残りを続ける。**どのケースで落ちたかを知るために測っている**ので、
1 件目で止まると何も分からない。

### e2e では最後に、専用のレコードで測る

読み取り専用フィールドや不正な値を渡すのでフォームが汚れる。
途中に混ぜると**そのあとの保存が失敗して採取全体が壊れる**。
専用のレコードを REST で作り、編集画面で測り、**保存せずに離れる**。

保存できるかは別の話（REST 側は `write-behavior.md` で測ってある）。

### probe を変えたら貼り直しが要る

`probe-dist/probe.js` が 42.9 kB → 52.5 kB になった。
`app:check-probe` が配信物のハッシュを手元のビルドと比べているので、
**貼り直すまで週次のライブ検証（`live.yml`）が失敗する**。

```
pnpm run probe:build && pnpm run app:deploy-probe
```

`app:deploy-probe` は kintone のシステム管理権限が要り、組織全体に効く。
**この PR をマージしたら、実測の前に貼り直す必要がある。**

## 空のレコードで測ると「変化なし」しか出ない（#14）

**2026-09-08。** 段階 B の 3 回目は採取そのものは通ったが、
**結果が根拠にならなかった。** 19 ケース中 17 件が「変化なし」。

原因は測定用レコードを必須フィールドだけで作っていたこと。

```ts
record: { singleLineTextRequired: { value: "set() の受け入れ測定用" } }
```

| 起きたこと | なぜ |
|---|---|
| `before` が `<undefined>` | 未入力なので、`null` を渡しても差が読めない。無視されたのか適用されて `undefined` になったのか区別できない |
| **読み取り専用が全部「無視された」** | `get()` の値を**そのまま**渡していた。**変わらないのが当たり前** |
| `FILE` の 3 ケースが飛んだ | 添付が無い |
| 最後の 2 件を区別できない | `no-type` の直後が `unknown-field-code` で両方エラー。**前のケースの残りか判定できない** |

**「無視された」の大半は「測れていない」だった。**
それを `fixtures/set-behavior.md` に書けば、
このリポジトリが警戒している状態そのものになる。

> 誤った実測がそのまま基準データになる

生成した md は捨て、`fixtures/measured.json` も戻した。

### 直した 4 点

| | 直し方 |
|---|---|
| レコードが空 | **`filledRecord` を使う。** 検証アプリの構築で使っているものと同じで、添付も含む |
| 同じ値を渡していた | **違う値**を渡す。`DIFFERENT_VALUE` に種別ごとに用意する |
| サブテーブルが読めない | 行 id の扱いだけを変え、**セルを 1 つ書き換える**。書き換える対象は `type` で探す |
| エラーの残りを区別できない | **各ケースの開始時に**エラー表示が無いことを確認する |

4 つ目が効く。いままで「リロードで消えるはず」を前提にしていて確かめていなかった。
確認を入れると**曖昧さが検出可能な失敗に変わる**。
消えていなければ、誤った結論を出す前に落ちる。

`setCases.test.ts` が「読み取り専用のケースが `CURRENT_VALUE` を渡していない」
「読み取り専用の全種別に渡す値が用意されている」ことを縛る。

### filledRecord は 2 件目を作れない（重複禁止フィールド）

**2026-09-08。** 4 回目は REST でレコードを作る時点で落ちた。

```
KintoneRestAPIError: [400] [CB_VA01] 入力内容が正しくありません。
```

`filledRecord` に `singleLineTextUnique`（`unique: true`）が入っており、
**検証アプリの構築で作ったレコードが同じ値を持っている**。
そのまま 2 件目として作ると重複で弾かれる。

`filledRecord` は「アプリ構築時に 1 回だけ使う」前提で書かれていて、
使い回す想定が無かった。使い回した側（測定用レコード）で値を差し替える。

`records.ts` の JSDoc に注意を書き、
`setCases.test.ts` が**アプリ本体の `unique: true` なフィールドが
測定用レコードで差し替えられている**ことを縛る。
unique な種別が増えたら落ちて差し替え漏れに気づける。
差し替えを消すと落ちることを確認した。

参照先アプリ（`lookupAppFields`）の `key` にも `unique: true` があるが、
別アプリなので対象外。テストは `fixtureAppBaseFields` 以降だけを見る。

### page.goto はハッシュだけの違いでは画面を作り直さない

**2026-09-08。** 5 回目は**開始時チェックが狙いどおり検出した**。

```
Error: set() のケース id-revision を始める前（前のケースのエラー表示が残っている）
```

`id-revision` の直前は `readonly-category`。
そこで出たエラー表示が、**リロードしても消えていなかった**。

原因は `page.goto` が**リロードになっていなかった**こと。
`/k/2/show#record=X&mode=edit` はハッシュだけが違う同じ URL なので、
すでにその URL に居ると遷移が起きない。

**1 回もリロードされていなかった**。
3 回目の採取で `app.record.edit.show` のサンプルが
**1 件しか増えていなかった**のがその証拠だったが、
そのときは「重複が少なくて良い」と読んで見過ごした。
21 回リロードしたなら 20 件増えるはずで、**数字が仮説と合っていなかった**。

2 件目以降は `page.reload()` にする。

### リロードすると show イベントのサンプルが積み上がる

本物のリロードにすると、そのたびに `app.record.edit.show` が飛んで
**同じ文脈のサンプルが 20 件以上積み上がる**。
情報は増えないのに `measured.json` が膨らみ、週次の差分が読めなくなる。

`store.add` に停止フラグを置き、測定中だけ自動採取を止める。
`addSetCase`（測定そのもの）は止めない。

フラグは **localStorage に置く**。show イベントはページ読み込み中に飛ぶので、
e2e がリロードごとに立て直す形にはできない。

**必ず戻す。** 止めたままにするとこのあとの採取が全部消えるので、
`finally` で戻す。`setCases.test.ts` が
「`reload` を使っている」「停止を `finally` で戻している」ことを縛る。
どちらも変異させると落ちることを確認した。

### 6 回目でようやく使える結果が出た。ただし FILE が 2 回続けて飛んだ

**2026-09-08。** 採取が通り、**null と読み取り専用について答えが出た**。
一方 `FILE` の 3 ケースは 2 回続けて飛び、
**理由を残していなかったので、もう 1 回走らせないと分からない**状態になった。

「この画面に対象のフィールドが無い」という記録だけでは、
**フィールドが無いのか、あるが中身が空なのか**が区別できない。

`ResolvedCodes` に `found`（何が見つかったかの覚え書き）を足し、
飛ばした理由に添えるようにした。`FILE` と `SUBTABLE` は
「あるが空」で飛ぶことがあるので**要素数まで残す**。

**飛ばした記録には、次に何を直せばよいかが書かれていないといけない。**
そうでないと 1 回の実測が 1 つの疑問しか解かない。

### 自動採取の停止は最初の遷移より前に立てる

6 回目でサンプルが 3 件増えた。20 件の積み上がりは防げたが、
**2 件は避けられたもの**だった。

| 増えた | 理由 |
|---|---|
| `app.record.edit.show` | **開いてから停止を立てた**ので 1 件目の show が採られた |
| `app.record.index.show` | 測定後に解除してから離脱したので、離脱先の show が採られた |
| `mobile.app.record.detail.show` | この測定とは無関係。既存の揺れ |

フラグは localStorage なので、**いま開いている画面で立てれば遷移後も効く**。
立てる位置を最初の遷移より前に移し、
離脱先（`leaveTo`）も `measureSetBehavior` の中で踏むようにした。

### waitForPanel は Playwright の既定 5 秒では足りない

**2026-09-08。** 7 回目は保存直後の詳細画面への遷移で落ちた。

```
Expected: "screen.detail"   Received: "screen.create"
- waiting for ".../k/2/show" navigation to finish...
- navigated to ".../k/2/show#record=126"
```

**遷移そのものは成功していた**（レコード 126 が作られ、URL も変わった）。
5 秒のあいだにパネルの再描画まで届かなかっただけ。
ログインが 14 秒かかった実行で、環境が遅い日に当たると起きる。

`waitForPanel` が待つのは 4 つの合計。

1. 遷移
2. ページの読み込み
3. kintone のカスタマイズの起動
4. パネルの描画と画面判定

`expect` はポーリングなので、速いときに長い値が待ち時間になることはない。
**短く見積もる利点が無い**ので 30 秒にした。

これは私の変更が原因ではない（落ちたのは測定より前の箇所）。
ただし実測の回数を増やすほど遅い日に当たる確率が上がるので、
測定を続けるうえで塞いでおく必要があった。

### kintone.app.record.get() は編集画面で FILE を空配列で返す

**実測 2026-09-08。** 8 回目で `FILE` が飛んだ理由が判明した。

```
対象のフィールドが無い（種別 28 個 / file(FILE)=0 / subtable(SUBTABLE)=3）
```

**フィールドは在る。値が空**だった。同じレコード・同じ画面で、

| 取得元 | FILE の要素数 |
|---|--:|
| `app.record.edit.show` の `event.record` | **1** |
| `kintone.app.record.get()` | **0** |

添付がある保存済みレコードなのに、`get()` では `value` が `[]` になる。

**「同じ画面なら同じ値」ではない**という例がまた 1 つ増えた。
`undefined` が付くかも取り方で決まる（別項）ので、
**FILE の中身も取り方で決まる**。

`Editing.File` の型は `FileInformation[]` で `[]` も妥当なので、
**型の修正は要らない**。ただし
「`get()` で添付一覧が取れる」と思って書いたコードは静かに空を掴む。

測定側は `event.record` で見えた値に落とす。
1 ケースごとにリロードするので show イベントが毎回飛び、そのたびに更新される。
どちらから採ったかは `found` に残す（`file の出どころ=event.record`）。

**この差は 3 回の実測を無駄にしてから分かった。**
1 回目は空のレコードだったので気づけず、
2 回目は飛ばした理由に証拠が無くて分からず、
3 回目でようやく特定できた。
**飛ばした記録に証拠を添えていれば 1 回で済んだ。**

### 観測できないものを「無視された」と書かない

**2026-09-08。** 9 回目で 22 ケース全部に答えが出た。ただし表が 2 箇所で嘘をついていた。

**1 つ目: FILE。** `get()` が常に空配列を返すので、
`before` も `after` も `file=[]` になり「無視された」と判定されていた。
**実際は「エラーは出なかった。変化は観測できない」**。

`unobservable` の印を付け、結論を分けた。
`setCases.test.ts` が「FILE のケースに印が付いている」
「FILE 以外には付いていない」の両方を縛る
（観測できるケースに付けると検出力が落ちる）。

**2 つ目: サブテーブルの行 id。** 正規化で `<row-id>` に伏せられるので、
`before` と `after` を並べても比較できない。
真偽値は環境に依らないので、**probe 側で比べて `rowIdsPreserved` に残す**。

### set() は行 id を渡さなくても保つ（REST と逆）

**実測 2026-09-08。** 行 id を外して渡しても、前後で id が一致した。

| | 行 id を落として渡すと |
|---|---|
| REST `updateRecord` | **行が置き換わり、新しい id が振られる**（`write-behavior.md`） |
| `kintone.app.record.set()` | **id が保たれる** |

セルの書き換えは効いているので、`set()` が丸ごと無視したのではない。
行数を変えていない場合の結果で、**行数を変えたときは測っていない**。

REST 側は「id を落とすとデータが壊れる」ので変換の必須要件だが、
`set()` 側は必須要件ではない。**同じ「書き込み」でも要件が違う。**

### set() の受け入れ挙動（実測 2026-09-08・22 ケース）

`fixtures/set-behavior.md` が全文。`toSetRecord` の根拠。

| 渡したもの | 結果 |
|---|---|
| `null`（`DROP_DOWN` / `DATE` / `TIME` / `SINGLE_LINE_TEXT`） | **受け入れ。値が未入力になる** |
| 読み取り専用 7 種別に別の値 | 無視される（エラーも変化もなし） |
| **`CATEGORY` に別の値** | **拒否** |
| `$id` / `$revision` に別の値 | 無視される |
| `CALC` に別の値 | 無視される |
| `FILE`（4 キー / `fileKey` だけ / 空配列） | エラーなし（変化は `get()` で観測できない） |
| サブテーブル（行 id あり / なし） | 受け入れ。**どちらでも行 id が保たれる** |
| `confirmed` / `recordId` を付けたまま | 受け入れ |
| `type` を省く | **拒否**（2026-08-30 の実測と一致） |
| 存在しないフィールドコード | **拒否** |

### REST と set() は要件が違う

同じ「書き込み」でも落とすべきものが違う。**片方の結果を流用できない。**

| | REST `updateRecord` | `kintone.app.record.set()` |
|---|---|---|
| 読み取り専用 8 種別 | **全部拒否**（落とすのは必須） | `CATEGORY` だけ拒否。他は無視 |
| 行 id を落とす | **行が置き換わりデータが壊れる** | id が保たれる |
| `CALC` | 受け入れて無視 | 無視 |
| `type` の省略 | （REST は `{ value }` のみで可） | **拒否** |

### toSetRecord は何をすべきか

| 種別 | 落とすか | 理由 |
|---|---|---|
| **`CATEGORY`** | **必須** | 唯一エラーになる |
| `RECORD_NUMBER` / `CREATOR` / `CREATED_TIME` / `MODIFIER` / `UPDATED_TIME` / `STATUS` / `STATUS_ASSIGNEE` | 整形 | 無視されるだけ。送る意味がない |
| `__ID__` / `__REVISION__` | 整形 | 同上 |
| `CALC` | 整形 | 同上 |
| `FILE` | **触らない** | 4 キーのままで通る |
| サブテーブルの行 id | **触らない** | 落としても保たれる |
| `confirmed` / `recordId` | 整形 | 付けたままでも通る |
| `type` | **必須で付ける** | 省くと拒否される |

**必須要件は 2 つだけ**（`CATEGORY` を落とす / `type` を付ける）。
残りは整形で、落とし漏れがあっても壊れない。
REST 向けの `toRestWrite` は 8 種別すべてが必須要件だったので、
**同じ実装を使い回せない**。

### この 3 回で学んだこと

段階 A（測る前にレビューできる形にする）を分けたのに、
**3 回とも走らせてから設計の穴が出た。**

| 回 | 出た穴 | 事前に分かったか |
|---|---|---|
| 1 | `set()` の失敗は例外にならない | **分かった。`e2e/panel.ts` に書いてあった** |
| 2 | `page.once` のリスナー漏れ | 分からない。潜在していた |
| 3 | 空のレコードでは signal が出ない | **分かった。「変わらないのが当たり前」は走らせる前に気づける** |
| 4 | `filledRecord` は 2 件目を作れない | 分からない。`unique: true` は fields.ts を読めば見えるが、使い回しの前提は書かれていなかった |
| 5 | `page.goto` がリロードになっていない | **手元の数字に出ていた。** 3 回目で `edit.show` が 1 件しか増えていないのを見ながら見過ごした |
| 6 | `FILE` が飛んだ理由が残っていない | **分かった。** 飛ばす経路を書いた時点で「理由に証拠を添える」と決められた |

1 と 3 は**走らせる前に気づけたもの**。
段階を分ける意味は「実行しないと分からないこと」だけを実行に回すことなので、
分けただけでは足りず、**分けた中身を既存の記録と自分の仮説に照らす**必要がある。

## toSetRecord は toRestWrite と別に持つ

**2026-09-08。** Q8 の計画にあった `forJsSet` を、実測を根拠に実装した（#14）。
名前は `toSetRecord`。既存の `toRestWrite` と対になるよう `to` で始める。

**同じ実装を使い回さない。** 落とすべきものが違う
（`fixtures/set-behavior.md`・22 ケース）。

| | `toRestWrite` | `toSetRecord` |
|---|---|---|
| 落とすのが必須 | 読み取り専用 8 種別 | **`CATEGORY` だけ** |
| 行 `id` | **必ず渡す**（落とすと行が置き換わる） | 渡す（落としても保たれるが、REST の行をそのまま扱えるように） |
| `type` | 付けない（REST は `{ value }`） | **必ず付ける**（省くと拒否） |
| `FILE` | UI 専用プロパティを落とす | **触らない**（4 キーで通る） |
| `null` | 送る | **送る**（未入力になる） |

`REJECTED_ON_WRITE` を流用すると、`set()` では**厳しすぎる**
（無視されるだけの 7 種別を必須要件として扱うことになる）。
逆に `set()` 側を流用すると REST で**緩すぎる**（必ず失敗する）。

### 実測から引いて縛る

`toSetRecord.test.ts` は `fixtures/measured.json` の `setBehavior` を読み、
**実測で拒否された種別と `REJECTED_ON_SET` が一致すること**を確かめる。
表を手で写すと、採り直したときに静かにずれる。

3 通り壊して確認した。

| 壊し方 | 結果 |
|---|---|
| `CATEGORY` を落とすのをやめる | 5 件落ちる |
| REST と同じ 8 種別を拒否扱いにする | 2 件落ちる |
| 受け入れられる種別（`DROP_DOWN`）を落とす | 1 件落ちる |

### 「拒否されたケースの種別」は「拒否される種別」ではない

最初この推論で書いてテストが落ちた。
`unknown-field-code` は `SINGLE_LINE_TEXT` を渡すが、
**拒否理由はフィールドコードが無いこと**で、種別は無関係。

ケース定義に `isolates`（何を切り分けているか）を足し、
それが付いているケースだけから種別を引く。
`no-type` / `unknown-field-code` / `lookup-extra-keys` / `id-revision` には付けない。

`isolates` は**フィクスチャに持たせずケース定義から id で引く**。
フィクスチャに持たせると、定義を直すたびに採り直しが要る。

## ソースを読むテストは「そこに在る」ことを先に確かめる

**2026-09-08。** `set()` の測定を `main.ts` から `runSetCase.ts` へ切り出したとき、
**テストが `main.ts` を見たまま緑だった。**

```ts
const source = readFileSync("src/probe/main.ts", "utf8");
const runSetCase = source.slice(source.indexOf("const runSetCase = "), …);
expect(runSetCase).not.toContain("catch");   // 空文字列を検査していた
```

`indexOf` が `-1` を返し、`slice` が空文字列になり、
**「catch を含まない」が自明に真**になっていた。何も守っていない。

`codeOf(path, anchor)` に寄せ、**`anchor` が見つからなければ落とす**ようにした。
リポジトリ内のソースを読むテスト 6 箇所すべてを通した。
対象を `main.ts` に戻すと落ちることを確認した。

### 併せて: 方針を JSDoc で説明していると、自分の説明文に当たる

`try/catch を置かない` を縛るテストが、
**その方針を説明している JSDoc の「try/catch」に当たって**落ちた。

`codeOf` はコメントを外してから返す。
文字列でソースを検査するときは、**コメントは検査対象ではない**。

### 「テストが在る」と「テストが効いている」は別

このリポジトリで繰り返し出てくる形。今回で 4 例目。

| 例 | 何が自明に真だったか |
|---|---|
| ガードのテストがフィールドコードで引いていた | 1 件見つかれば緑 |
| `not.toBeNever()` | `unknown` は never ではない |
| `pack:check` の `nodenext` | `any` は何を書いても通る |
| **ソースを読むテストの対象が消えた** | **空文字列は何も含まない** |

いずれも「落ちるはずのものを落として確かめる」までは気づけなかった。

## probe と e2e の契約を型でも 1 箇所にする

**2026-09-08。** `ACTION`（ボタンの識別子）は `testIds.ts` で 1 箇所管理していて、
理由もそこに書いてある。

> Playwright 側でリテラルを書くと、probe を直したときに黙ってずれる。
> このプロジェクトで何度も塞いできた形なので、最初から 1 箇所にする。

**同じ理屈が API の形には適用されていなかった。**
`window.__kintoneRecordProbe` の型（17 メンバ）を e2e 側で手で書いていた。

`setCaseIds` / `runSetCase` / `markSetCase` / `suppressSamples` を足したとき、
両側に手で書いた。**一致していたのは気をつけたからで、仕組みではなかった。**

`src/probe/api.ts` に `ProbeApi` を置き、
`main.ts` が `satisfies ProbeApi` で代入し、e2e はそれを import する。

両方向で落ちることを確認した。

| 壊し方 | 結果 |
|---|---|
| 型に足して実装に足さない | `TS2741: Property … is missing` |
| 実装の引数を変える | `TS2322: '(id: number) => boolean' is not assignable` |

`satisfies` にするのは `GUARD_OF` と同じ理由。
型注釈（`: ProbeApi`）にすると各メンバの具体的な型が潰れるが、
`satisfies` なら書き忘れは同じように落ちたうえで具体的な型が残る。

## dialog の登録はヘルパ 1 箇所に閉じる

**2026-09-08。** `page.once("dialog", …)` を直に書く形が 2 箇所あり、
どちらも `try` / `finally` で外す同じ骨格だった。
**外し忘れると数十行離れた場所で壊れる**（実際に踏んだ）ので、
寿命をヘルパが持つ形にした。

```ts
await withDialogsAccepted(page, async () => { … });
```

`setCases.test.ts` が「登録は 1 箇所だけ」「その 1 箇所はヘルパの中」を縛る。

### 変異テストが甘くて 2 回見逃した

このガードを確かめる過程で、**自分の変異が当たっていない**のに
「通った」と読みかけた。2 回とも私の作り方の問題だった。

| 回 | 変異 | なぜ当たらなかったか |
|---|---|---|
| 1 | ヘルパの外に `page.on` を足す | 切り出し範囲の外だった |
| 2 | ヘルパの外に `p.on("dialog", …)` を足す | **正規表現が `page.on` しか見ていなかった** |

2 回目が効いた。**レシーバ名で絞ると `p` や `this` で抜けられる。**
引数が `"dialog"` であることだけを条件にした。

`grep` でソースを検査するときは、**変数名に依存しない形**にする。
そして**変異が当たったことを表示してから**結果を読む
（「仕込みが当たったことを先に確かめる」は別項でも書いた）。

## 型チェックの門は tsconfig の include 1 行で開く

`tsconfig.json` の `include` に `e2e/**/*` が無く、**`e2e/` は型を誰にも
見られていなかった**。`e2e/panel.ts`（869 行）と `e2e/collect.spec.ts`（491 行）が
対象外で、`const x: number = "文字列";` を足しても `pnpm run check` は緑だった。

門が 3 つあるように見えて、実際は 1 つしか型を見ていない。

| | e2e を見るか | 型を見るか |
|---|---|---|
| `biome check` | 見る | **見ない**（lint と整形だけ） |
| `vitest --typecheck` | 見ない | `*.test-d.ts` だけ |
| `tsc --noEmit` | **include 次第** | 見る |

これが効いたのは #23 で、`ProbeApi` を「probe と e2e の唯一の出どころ」に
した回。`src/probe/api.ts` の JSDoc に「片方だけ直すと `tsc` が落ちる」と
書き、実装（`satisfies`）側は確かに落ちることを確かめた。
**e2e 側は落ちなかった。** 目的の半分が仕組みになっておらず、
コードのコメントがそれを「なっている」と主張していた。

`include` に 1 行足すだけで既存の診断はゼロ。存在しない probe メソッドの
呼び出しは `TS2339`、素の型エラーは `TS2322` で落ちるようになった。

### ディレクトリを名指しで縛らない

`test/typecheckScope.test.ts` は「`e2e` が入っているか」ではなく
**「`.ts` を置いた最上位ディレクトリが全部入っているか」**を縛る。
名指しだと次に足すディレクトリで同じ穴が開く。この漏れの形は
「ディレクトリを足したときに `include` を直し忘れる」なので、
縛るべきは並びそのものではなく対応関係。

### tsconfig を読むときブロックコメントは剥がせない

`include` の値が `"src/**/*"` で、**この中に `/**/` が入っている**。
`/\*[\s\S]*?\*\//` で素朴に剥がすと値が `"src*"` に壊れる。
実際にそれで書いて、書いたテストが落ちて気づいた。

その次に「`/\*` を含まないこと」で縛ろうとしたが、これも間違い。
**値そのものが `/\*` を含む**ので、正しい tsconfig で落ちる。
剥がすのは行全体がコメントの行だけにして、ブロックコメントが入ったら
`JSON.parse` の構文エラーに任せる。

### 変異の判定に部分一致を使うと嘘になる（4 度目）

この回、変異テストの緑判定を `"passed (2)" in 出力` で書いた。
変異が当たったときの出力は `1 failed | 1 passed (2)` で、
**`passed (2)` を含むので「見逃した」と報告してしまった**。
手で走らせ直すと実際には落ちていた。

同じ間違いを [`dialog の登録はヘルパ 1 箇所に閉じる`](#dialog-の登録はヘルパ-1-箇所に閉じる) でも
2 回している（レシーバ名で絞った正規表現）。判定は
**要約行を取り出して `failed` の有無と終了コードで見る**。部分一致で書かない。

## page.evaluate の中で window から probe を取り出す形に名前を付ける

`page.evaluate` のコールバックはブラウザで動くので、e2e 側の変数もヘルパも
閉じ込められない。probe は `window` から取り出すしかなく、その取り出しが
`e2e/panel.ts` に **20 箇所、同じ形で書かれていた**。

```ts
(
	window as unknown as { __kintoneRecordProbe: ProbeApi }
).__kintoneRecordProbe.count()
```

これを `ProbeWindow` / `MaybeProbeWindow` として `src/probe/api.ts` に置いた。
3 行が 1 行になり、`panel.ts` は 869 → 845 行。

### 型を 2 つに分ける理由

内訳は**非任意 18 箇所・任意 3 箇所**だった。任意なのは `waitForPanel` の
ようにパネルが立つのを待つ側で、カスタマイズの読み込み前は本当に
`undefined` になる。**両方あるのは正しい。** ただし同じキャストが
散っていると、どちらを使うかが偶然に見える。型の名前で理由を残す。

非任意で書いた側で待とうとすると、待てているように見えて待てていない。
これは 1 つの型に寄せると消える区別なので、寄せない。

## ソースを読むテストは整形に依存させない

`suppressSamples` の停止と再開が対になっているかを見るテストが、
`suppressSamples(true)` を**文字列で**探していた。

`window` のキャストを短くしたら biome の折り返しが変わり、
呼び出しが `suppressSamples(\n\ttrue,\n)` になって一致しなくなった。
**中身は何も変えていないのにテストが落ちた。**

落ちたのは良いことだが（黙って緑になるより遥かにいい）、
縛っていた対象が呼び出しではなく**整形**だった。
逆向きの失敗もあり得る形で、引数の名前が変わったことに気づけない。

引数は正規表現で探す（`/suppressSamples\(\s*true\s*[,)]/`）。
1 行に詰めても折り返しても緑になり、停止・再開・`finally` の外出しの
どれを崩しても落ちることを変異で確かめた。

同じファイルの `page.reload()` を見るテストも `codeOf` に寄せた。
[`ソースを読むテストは「そこに在る」ことを先に確かめる`](#ソースを読むテストはそこに在ることを先に確かめる) で
6 箇所を寄せたが、この 2 つが残っていた。`readFileSync` は `codeOf` の
中だけになった。

## パネルのボタンは id と処理の対応を 1 箇所にする

`boot` の中で画面ごとの `switch` に `{ id, text, run }` を書き下していて、
**13 個のうち 9 個が 2〜3 回書かれていた**（`JS API で採取` は 3 回）。

`ACTION` の id は `testIds.ts` の 1 箇所管理になっている。
**id と `run` の対応だけが画面ごとに手写しだった。**
片方の画面だけ `run` を打ち間違えても型は通り、e2e は違う操作を測って
**それらしい結果**を出す。`ProbeApi` を 1 箇所にしたのと同じ穴。

3 つに分けた。

| | 持つもの |
|---|---|
| `ACTIONS` | id → 表示と処理。`Record<ActionId, ...>` |
| `SCREEN_ACTIONS` | 画面 → 出す id の並び。`Record<Screen, ...>` |
| `SET_ACTIONS` / `COMMON_ACTIONS` | まとまりに名前を付けたもの |

### `default:` を無くしたのが一番効いている

以前は `switch` の `default:` が詳細画面のボタンを返していた。
`Screen` は 4 つしか無いので結果は同じだが、**画面を足したときに
黙って詳細画面のボタンが出る**。`Record<Screen, ...>` にすると
`TS2741` で落ち、その画面で何を出すかを決めさせられる。

### 文言だけ違う場合は id で揃えて文言を上書きする

一覧画面の `rest` は「REST 一覧で採取」と表示する。
`getRecord` ではなく `getRecords` になるという実際の違いなので、
文言は残す。`ActionId | { id, text }` の並びにして、
**違うのは表示だけで処理は同じ**であることを形で示す。

### 型で落ちることを確かめた

| 変異 | 診断 |
|---|---|
| `ACTION` に足して `ACTIONS` に書き忘れる | `TS2741` |
| `Screen` に足して `SCREEN_ACTIONS` に書き忘れる | `TS2741` |
| `SCREEN_ACTIONS` に存在しない id を書く | `TS2322` |
| 文言の上書きで `id` を書き忘れる | `TS2322` |

置き換え前後で、4 画面すべてのボタンの並びが一致することを
`switch` から抽出して突き合わせた。`main.ts` は 977 → 954 行。
**行数はほとんど減っていない**（表の JSDoc が増えた分で相殺）。
狙いは行数ではなく、対応が 1 箇所になることと型で落ちること。

## 実行スクリプトの入口を 1 箇所にする

`tools/` のスクリプト 9 本が、それぞれ末尾に入口を持っていた。
7 本は同じ 4 行の `main().catch(...)`、2 本（`packCheck.ts` /
`fixture/setBehavior.ts`）は `main();` の直呼び。

**7 本のうち 1 本だけ `describeError` ではなく `String(error)` だった**
（`fixture-app/verify.ts`）。`describeError` は kintone の REST エラーの
`errors` を展開してフィールドごとの理由を出す。`String` にすると
`KintoneRestAPIError: 入力内容が正しくありません` の 1 行で終わる。

よりによって `verify.ts` は**検証アプリのフィールドの食い違いを報告するのが
仕事**で、9 本の中で一番情報の少ない出力になっていた。
写して回ると、こういう食い違いが黙って残る。

`@jissoku/rig` の `runScript(main)` に寄せた。同期の `main` も受ける。

### `describeError` を `client.ts` から出した

この関数は kintone の何にも触らない純粋関数なのに `client.ts` にあった。
`run.ts` から使うと、`packCheck.ts` のような **kintone を使わない
スクリプトが `@kintone/rest-api-client` を引き込む**。
`@jissoku/rig` の `describeError` に分けた。

### スタックも出す（意図した変更）

`describeError` は `Error` から `message` しか取らない。kintone の REST
エラーには十分だが、**素の `TypeError` では 1 行しか出ず、どこで落ちたか
分からない**。`pack:check` は CI で走るので、そこで 1 行だけ出ても直せない。
以前の 7 本も同じ状態だった。出る情報が減る場合は無い。

**1 回の `write` にまとめる。** パイプ越しの stderr は非同期になり得るので、
直後の `process.exit` で途中まで消える。2 回に分けるとスタックだけ落ちる。
`tsx` でパイプに流して、終了コード 1 とスタック 4 行が揃うことを確かめた。

### 変異が JSDoc に当たっていた（5 度目）

`process.exit(1)` を `exit(0)` に変える変異が「見逃した」と出た。
実際は **JSDoc に書いたコード例に当たっていた**。
`ns != s` は成立するので、変異が当たった判定としては役に立たない。

コメントを除いた本体に対象が在ることを先に確かめ、
**本体側の出現位置を特定してから**置き換えるようにしたら、
`exit(0)` も `exit` を消す変異も検出された。

「変異が当たったことを表示してから結果を読む」を
[`dialog の登録はヘルパ 1 箇所に閉じる`](#dialog-の登録はヘルパ-1-箇所に閉じる) と
[`型チェックの門は tsconfig の include 1 行で開く`](#型チェックの門は-tsconfig-の-include-1-行で開く) にも書いたが、
**「当たった」の確かめ方が甘いという形**でまた踏んだ。
差分が出たことは、意図した場所に当たったことを意味しない。

### マイクロタスクを決まった回数待たない

`runScript` の中を `main().catch()` から `Promise.resolve().then(main).catch()`
に変えた瞬間、`await Promise.resolve()` を 2 回挟んでいたテストが
**空の出力を読んで落ちた**。段数に依存していた。
`setImmediate` まで待てば、その時点のマイクロタスクは全部流れている。

## export した先が無いことを検査する

`biome --error-on-warnings` は**ファイル内**の未使用を見るが、
**export した先が無いこと**は見ない。以前 `fieldsOfType` が死んだまま
緑で通っていたのを見つけて `--error-on-warnings` を足したが、
塞がったのは半分だった。

`test/deadExports.test.ts` を足した時点で 15 件出た。

| | 件数 | 内容 |
|---|--:|---|
| どこからも参照されていない | 2 | `e2e/panel.ts` の `sampleCount`（最初のコミットから）、`test/jsApi.ts` の `OfficialJsApi`（#10 から） |
| 自分のファイルの中でだけ使う | 13 | `export` を外した |

後者を放っておくと、そのファイルが**外に何を提供しているのか**が読めない。
`e2e/panel.ts` は spec から使うヘルパを並べたファイルなのに、
`assertNoCustomizeError` / `fieldInput` / `subtableCellInput` は
どの spec からも使われていなかった。

### 公開 API のファイルだけ除外する

`src/index.ts` と `src/kintone.ts` の export は外から参照されないのが正常。
`package.json` の `exports` が `.` と `./kintone` の 2 つだけなので、
利用者から見える入口もこの 2 つ。ここを除外しないと全滅する。

### コメントを剥がさないと検出したいものが素通りする

死んだ export ほど JSDoc で言及されがち。剥がさないと
「他のファイルのコメントに名前が出ている」を参照と数えてしまう。
実際に、死んだ export を足したうえで別ファイルのコメントに名前を書いた
変異を作り、**剥がしをやめると見逃す**ことを確かめた。

### `\b` は非 ASCII の識別子に使えない（変異テストで踏んだ）

「使われない export を足す」変異を `export const 誰も使わない = 1;` で
書いたら**見逃した**。原因は 2 つあって、どちらも同じ根っこ。

- 宣言を拾う正規表現が `(\w+)`。`\w` は ASCII なので**そもそも拾えない**
- 参照の判定が `\b名前\b`。`\b` は `\w` を基準にするので**どこにも一致しない**

拾えないと「参照ゼロ・宣言も無し」になり、export したことすら検知できない。
今のリポジトリに非 ASCII の export は無いが、足した瞬間に黙って漏れる形。

`[\p{ID_Start}$_][\p{ID_Continue}$]*` と
`(?<![\p{ID_Continue}$])名前(?![\p{ID_Continue}$])` に直した。
非 ASCII 名の変異でも検出されることを確かめた。

## DOM の型は Api 名前空間の中に置く

`DomElement` / `DomBlob` を `src/types/jsApi.ts` の名前空間の外に
`export type` で置いていた。`dist/types/jsApi.d.ts` には出るが、
**`package.json` の `exports` は `.` と `./kintone` の 2 つだけ**なので
利用者からは名前で参照できなかった。

`Api.DialogConfig["body"]` の添字経由でしか触れず、
`showOpenDialog` に渡す body を変数に取る型が書けない。

`Api` の中に移して `Api.DomElement` として届くようにした。
`exports` を増やさずに済み、`Api` に閉じるので名前も汚れない。
利用者から見て**増えるだけ**で、壊れるものは無い。

`pack:check` の消費者コードに `Api.DomElement` / `Api.DomBlob` を足した。
名前空間の外に戻す変異で、4 レーンすべて `TS2694` で落ちることを確かめた。
DOM の無い Node レーンでも通る。

## `Api` を `tsumekae/kintone` からも export する

**2026-09-23、Issue #59。** `tsumekae/kintone` だけを import している利用者が
`kintone.proxy()` の戻り値（`Api.ProxyResponse`）のような、戻り値の中身を
型引数として直接参照したい場面で、`import type { Api } from "tsumekae";` を
別に書く必要があった。`Api` 自体はルートから既に export されており、
気づけば回避できるが、`tsumekae/kintone` だけを見ている利用者からは分からない。

理由は上の「DOM の型は Api 名前空間の中に置く」と同じ構図。
`exports` が `.` と `./kintone` の 2 つだけなので、利用者から見える入口に
`Api` を置く。今回は名前空間の中に移すのではなく、`src/kintone.ts` からも
同じ `Api` を re-export するだけ。**型の中身は変わらない、入口が増えるだけ。**

`src/kintone.ts` は元々 `import type { Api }` を内部で使っており、
`export type { Api } from "./types/jsApi.js";` を足しても
`declare global` の扱い（副作用 import でだけ有効）は変わらない。

## typecheck を無効にすると、型テストは落ちずに消える

`package.json` の `test` は `vitest run --typecheck` だった。
`vitest.config.ts` に `typecheck.enabled: true` があるので、
**フラグは二重指定**で、外しても型テストは走る（実測で確認）。

外す前に、`enabled` 側が失われたときに何が起きるかを測った。

| | ファイル | テスト |
|---|--:|--:|
| `enabled: true` | 16 | 356 |
| `enabled: false` | **11** | **287** |

**落ちるのではなく収集されなくなる。** 嘘の型主張
（`expectTypeOf<string>().toEqualTypeOf<number>()`）を入れたまま緑になり、
5 ファイル・69 テストが消えたことは表示されない。

つまり `--typecheck` は「二重指定で無害」ではなく、
**`enabled` が失われたときの保険**だった。消すなら別の保険が要る。

`test/typecheckScope.test.ts`（`tsconfig.test.ts` から改名）に
`typecheck.enabled === true` と、リポジトリ内の `*.test-d.ts` が
全部 `include` に拾われていることを足した。
`vitest.config.ts` は import できるので、正規表現ではなく実際の値で見る。

門が 2 つあることを明示した。`tsc --noEmit` が見るのは
**書いたコードが型として通るか**まで。「型がこの区別をしていること」を
確かめているのは `*.test-d.ts` で、そちらは vitest が動かしている。
**どちらも設定の 1 行で閉じる。**

### glob を正規表現にするとき 1 回の走査で置き換える

`**/` を別の文字に退避させてから戻す書き方にしたら、退避先に制御文字を
使ったため biome の `noControlCharactersInRegex` に叱られた。
普通の文字にするとパターン自体と衝突し得る。
`replace` に関数を渡して 1 回の走査で処理する。

### 変異ハーネスのコメント除去がまた値を食った（6 度目）

`enabled: true` を `false` にする変異が「本体に対象が無い」で止まった。
原因は変異ハーネス側のコメント除去で、`/\*[\s\S]*?\*\//` が
**`"node_modules/**"` の `/\*` からブロックコメントとして食い始め**、
`enabled: true` まで飲み込んでいた。

[`型チェックの門は tsconfig の include 1 行で開く`](#型チェックの門は-tsconfig-の-include-1-行で開く) に
「tsconfig を読むときブロックコメントは剥がせない」と書いたのと**同じ罠**を、
今度はテスト側ではなく変異ハーネス側で踏んだ。
glob を値に持つ設定ファイルでは、行頭がコメントの行だけを落とす。

## バンドルに載る量は pack:check で突き合わせる

当時 README にあった「実行時に載る量」は手で測って書いたもので、
**測り方がどこにも残っていなかった**。0.2.0 の準備で測り直したら
3 行とも古かった。

| 使い方 | 書いてあった値 | 測り直した値 |
|---|--:|--:|
| ガードだけ | 2,006 B / 901 B | **2,194 B / 935 B** |
| 全部 | 8,916 B / 2,947 B | **9,630 B / 3,103 B** |

`toSetRecord` と 28 個のガードが入った分。
**古い数字は無い方がまし**なので、`tools/package/bundleSize.ts` が測り、
書いてある表と突き合わせる。`pack:check` から呼ぶので、ずれたら落ちる。
`check` は 4.6 → 6.7 秒。

### 数字の置き場を README から移す

**2026-09-09。** バイト数は README から落とした
（利用者が読む文書には要らない、という判断）。
数字ごと消すと**測り方がまた残らなくなる**ので、表はここに置く。

**2026-09-11 に 9,632 → 9,531 B。** `isSubtableRows` が
`toRestWrite` と `toSetRecord` に同じ実装で 2 つあったのを
`types/loose.ts` の 1 つにしたぶん減った。
除外の方針（REST と `set()` で違う）は分けたままで、
共有したのは「行の配列として読めるか」という骨格の判定だけ。

突き合わせる先は次の見出しの下だけ。DECISIONS のどこかに
同じ行が現れても拾わないように、見出しを目印にしている。

### 現在の値

Vite / esbuild minify / tree-shaking 有効。

| 使い方 | バンドルに載る量 | gzip |
|---|--:|--:|
| **型だけ**（`import type`） | **0 B** | **0 B** |
| `guard.*` だけ | 2,194 B | 935 B |
| 全部（`import * as`） | 9,531 B | 3,092 B |

### 入口を再輸出だけにする

`import` して使う形の入口にすると、**入口自身のコードが混ざる**。
最初にそう書いて「型だけ」が 0 B にならず 73 B と出た。
再輸出だけ（`export * from "tsumekae"`）にすれば、
出た量がそのまま tsumekae の分になる。

`sourcemap` も切る。`//# sourceMappingURL=` の 33 B が混ざる。
この 2 つを直して初めて「型だけ = 0 B」が**基準と一致する形で**出た。

### `**0 B**` の解析でずれた

表の値は `**0 B**` のように強調が付く。
`/\*\*|\s*B$/g` の 1 つの正規表現でまとめて落とそうとしたら、
**末尾が `**` なので `B$` に一致せず** `0 B` が残り、
正しい README に対して「ずれている」と報告した。
`**` を落としてから末尾の ` B` を落とす、と順に書く。

## 「落とす」をやめて「除く」に統一する

**2026-09-09。** README の「落とすものも変わる」が読み手に伝わらない、
という指摘から。「落とす」をこのリポジトリは **3 つの意味**に使っていた。

| 意味 | 例 |
|---|---|
| 送るデータから取り除く | 「`CATEGORY` を落とす」 |
| 検査が失敗する | 「ずれたら落とす」「undefined を渡しても落ちない」 |
| 別の値に寄せる | 「`event.record` で見えた値に落とす」 |

**1 つ目だけを「除く」に変える。** 残り 2 つは日本語として自然で、
言い換えると逆に読みにくい。**一括置換はできない**ので意味で分けて直した。

**公開 API の名前も変える。** 文章だけ変えると名前と食い違う。

| 変更前 | 変更後 |
|---|---|
| `isDroppedOnWrite` | `isExcludedOnWrite` |
| `isDroppedOnSet` | `isExcludedOnSet` |

`REJECTED_ON_*` / `IGNORED_ON_*` / `isRejectedOn*` は変えない。
**kintone の反応**を表す名前で、こちら側の動作ではない。

**deprecated エイリアスは作らない**（[10. 移行](#10-移行) と同じ方針）。
破壊的変更なので次のリリースは **0.3.0**。

`fixtures/*-behavior.md` の文言は `tools/fixture/setBehavior.ts` と
`tools/probe-write/writeProbe.ts` が書き出す**生成物**なので、生成側だけ直した
（次の採取で反映される）。この文書の過去の記述は当時の言葉のまま残す。

**バイト数が 2 B 増えた**（9,630 → 9,632 B）。export 名がバンドルに残るため。
[pack:check が拾って落ちた](#バンドルに載る量は-packcheck-で突き合わせる)ので表を更新した。
**名前を変えると出荷物のサイズが変わる**という当たり前のことが、測っていると見える。

## フォーム定義を測れる状態にする

**2026-09-10。** [フォーム定義は守備範囲に入れない](#フォーム定義は守備範囲に入れない)の結論は
変えないまま、**測る足場だけをこのリポジトリに置く**ことにした。
使うのは `kisekae`（`kintone-pretty-fields` の作り直し）。

### なぜ tsumekae のリポジトリに置くのか

測る対象が**この検証アプリそのもの**だから。
`tools/fixture-app/fields.ts` は全 28 種別＋ルックアップ（キー / コピー先 2 つ）＋
関連レコード一覧＋グループ＋サブテーブルを建てており、
`CATEGORY` は REST API が無いので**手動設定が済んでいる**。
同じものを別リポジトリに建て直すと、手動設定をもう一度やることになり、
しかも**片方のアプリ定義が変わったときにもう片方の実測が静かに古くなる**。
それを検出する仕組みはどこにも作れない。

### 足したもの

| | |
|---|---|
| `tools/fixture-app/layout.ts` | `SPACER`（名前あり / 名前なし）/ `LABEL` / `HR` を、トップレベルとグループの中の両方に置いた |
| `tools/fixture-app/collectForm.ts` | `getFormFields` / `getFormLayout` を採る（`app:collect-form`） |
| `tools/fixture/normalizeForm.ts` | 環境依存値を伏せる |
| `tools/fixture/formDefinition.ts` | 正規化の入口（`fixture:form`）。出力は `fixtures/form/definition.json` |

**ブラウザは使わない。** レコードの値は JS API / event / REST の 3 経路で形が違い、
それを測るために Playwright が要った。フォーム定義は REST の 1 経路しかないので
Node から素直に採れる。`e2e/` は tsumekae のものとして残る。

レイアウト要素は**1 行に 1 種類ずつ**置いた。混ぜると `updateFormLayout` に
弾かれたときにどれが原因か分からない。
ラベルの文字列は ASCII にした（`labelElement` / `labelInGroup`）。
`e2e/panel.ts` の `fieldInput` が `getByText(label, { exact: true })` で
フィールドのラベルから入力欄を辿るので、検証アプリの日本語ラベルと
衝突しない文字列でなければならない。

### 何を測るのか

フォーム定義の型は、ここまで `@kintone/rest-api-client` の型を読んで書かれてきた。
実測していない主張が 4 つある。どれも kisekae の型の骨格を左右する。

1. **ルックアップのキーフィールドは通常プロパティを返すか。**
   公式の型は `Lookup` を `type` / `code` / `label` / `noLabel` / `required` / `lookup` の
   6 つだけとし、`maxLength` などを持たない形で宣言している。
   返るなら「各型に optional な `lookup`」、返らないなら「種別ごとの独立メンバ」になる
2. **ルックアップのコピー先を、対象アプリのフォーム定義だけで判別できるか。**
   `kintone-pretty-fields` の `isLookupCopy` は元アプリの権限を要求していた
3. **`CATEGORY` / `STATUS` / `STATUS_ASSIGNEE` の `enabled` は設定を反映するか**
   （次の節）
4. **`SPACER` の `elementId` は名前なしのとき空文字列か。`LABEL` / `HR` は
   `getFormLayout` にどう現れるか。グループの中に置けるか**

`lang` は渡さない。ラベルにしか効かず、上の 4 点はどれもラベルに依存しない。
`preview` も渡さない（運用環境）。プラグインが実際に読むのは運用環境の定義。

**結果は[フォーム定義の実測でわかったこと](../../../docs/KINTONE.md#フォーム定義の実測でわかったこと)。**
4 件のうち 3 件で、ドキュメント由来の主張が外れた。

### 伏せるもの

`revision`（fields / layout の両方）、採取時刻、
`lookup.relatedApp.app` / `referenceTable.relatedApp.app`、
ユーザー / 組織 / グループの `code` と `name`。

**`{ type: "FUNCTION", code: "LOGINUSER()" }` の `code` は伏せない。**
kintone の関数名そのもので、個人情報ではなく測定の対象。
一律に伏せると「初期値にログインユーザーが指定されている」という情報が消える。
`tools/fixture/normalizeForm.test.ts` がこの例外を縛っている。

`properties` はキーで並べ替える（オブジェクトなので順序が揺れると毎回差分が出る）。
**`layout` は並べ替えない。** レイアウトの順序は測定対象そのもの。

## enabled は使える。「判定できない」は測っていないことを書いていた

**2026-09-10。**[調査済みの kintone / API の制約](../../../docs/KINTONE.md#調査済みの-kintone--api-の制約)に
こう書いていた。

> **`getFormFields` では CATEGORY / STATUS の有効・無効を判定できない**
> 設定が無効でも `カテゴリー` / `ステータス` を**常に返す**（2026-08-30 実測）

**前半は誤り。** 2026-08-30 に確かめたのは
「プロセス管理を有効化していないアプリでも両方が返る」= **キーの存在**だけで、
そこから「判定できない」を導いていた。`enabled` の値は測っていなかった。

気づいたきっかけは `kintone-pretty-fields` の実装。あちらは `enabled` で絞って
（`enabled: false` のフィールドを返さない）いた。両方が正しいことはあり得ない。

### 測った

`app:collect-form` で 2 つのアプリを同時に採ると、そのまま対照実験になった。

| アプリ | プロセス管理 / カテゴリー | `STATUS` | `STATUS_ASSIGNEE` | `CATEGORY` |
|---|---|---|---|---|
| 測定用（app=2） | 有効 | `enabled: true` | `enabled: true` | `enabled: true` |
| ルックアップ元（app=1） | 未設定 | `enabled: false` | `enabled: false` | `enabled: false` |

**`enabled` は設定を反映する。** 3 種すべてが返ること自体は変わらないが、
`enabled` を見れば有効・無効は分かる。キー集合も
`["code", "enabled", "label", "type"]` で両アプリとも同じ。

`kintone-pretty-fields` の実装が正しく、こちらの記述が間違っていた。

### tsumekae 側の対応は変えない

`tools/fixture-app/verify.ts` はレコードの `type` から検証している。
これはそのままで正しい（レコードに現れるかどうかは、`enabled` とは別の事実）。
`enabled` で判定する形にも書き換えられるが、**動いているものを
「新しく分かったから」で書き換える理由がない**。表の記述だけ直した。

### 何が悪かったのか

**測った範囲より広いことを書いた。** キーの存在を確かめて、
値の意味まで結論した。次にそこを読んだ人（今回は自分）は測り直さない。

この文書は「測っていないものを測ったふりで書かない」ことを
[実測とドキュメントを混ぜない](#実測とドキュメントを混ぜない)で自分に課しているが、
それは**型の JSDoc の話として**書いていた。この文書自身にも同じ規律が要る。

**実測の記述には、何を確かめたのかを書く。** 「常に返る」は確かめた。
「判定できない」は確かめていない。1 行の中でその 2 つが混ざっていた。

## fixtures/ の直下は「実測サンプル」専用

**2026-09-10。** フォーム定義の実測を `fixtures/form-definition.json` として
直下に置いたら、**レコードのテストが 22 件落ちた。**

`test/fixtures.ts` の `loadSamples` は `fixtures/` の `.json` を**全部**読んで
`store.samples` を展開する。`samples` を持たないファイルが 1 つ混ざると
`flatMap` に `undefined` が入り、20 フレーム先の
`const { event, source } = sample` で
「Cannot destructure property 'event' of 'sample' as it is undefined」として現れる。

**エラーが原因を指していない。** 22 件が一度に落ちるのに、
どれも「型の主張が実測と合わない」ように見える。
置き場所の問題だと気づくまでにフィクスチャを疑うことになる。

### 直した

- フォーム定義は `fixtures/form/definition.json` に置く。
  `readdirSync` は再帰しないのでサブディレクトリは対象外
  （`fixtures/live/` が既にそうなっている）
- `loadSamples` は `samples` の配列が無いファイルを見つけたら**落ちる**。
  メッセージに置き場所の指示を書いた

**黙って読み飛ばす形にはしない。** `measured.json` そのものが壊れたときに
「テストは緑だが実測を 1 件も見ていない」状態になる。
これは[「通ること」しか見ない検査は any を捕まえられない](#通ることしか見ない検査は-any-を捕まえられない)と
同じ形の穴で、フィクスチャ側にも同じ穴があった。

### なぜ気づかなかったか

`fixtures/` に置くファイルを増やしたのが初めてだった。
`fixtures/live/raw.json` と `fixtures/*-behavior.md` は、
たまたま**サブディレクトリ**と**`.json` 以外の拡張子**で回避していた。
「直下の `.json` は全部サンプル」という前提はどこにも書かれておらず、
`loadSamples` の実装にだけ表れていた。

## `$id` を保証する型を REST 側にしか用意していなかった

**2026-09-10、Issue #34。** `RestRecordWithMeta` はあるのに、
`SavedRecord` / `EditingRecord` に対応するものが無かった。

レコード型はインデックスシグネチャなので `record.$id.value` が
**28 種別の `value` の合併型**になり `string` に絞れない。
`updateRecord` の `id` に渡そうとすると型エラーになる。

REST 側でその問題を解いておきながら、**同じ問題が JS API 側にもあることを
見落としていた。** 報告者は複数のプラグインで同じローカル型を書き写していた。

```ts
export type SavedRecordWithMeta = SavedRecord & { $id: Saved.Id; $revision: Saved.Revision };
export type EditingRecordWithMeta = EditingRecord & { $id: Editing.Id; $revision: Editing.Revision };
```

インデックスシグネチャとの交差型が効くのは、TypeScript が
**判別子が矛盾する交差型を `never` に畳む**ため。`Saved.OneOf & Saved.Id` は
`type` が `"SINGLE_LINE_TEXT" & "__ID__"` のように潰れるメンバが消えて
`Saved.Id` だけが残る。`RestRecordWithMeta` が既にこれで動いていた。

**`CreateRecord` の版は作らない。** 作成画面には `$id` / `$revision` が
存在しない（実測: 作成画面 28 フィールド / それ以外 37 フィールド）。
`EditingRecordWithMeta` も作成画面の `event.record` には使えない。
そこは型では止められないので JSDoc に書いた。

`test/dist/consumer.ts` が `.d.ts` の出力でも交差型が保たれることを見る。
TS 7 で `field.subtableRow` の `id?: never` が宣言出力から落ちた前例があり、
**src のテストが全部通ったまま利用者側だけ壊れる**ことが実際に起きている。

## イベントの `record` を `*WithMeta` で宣言する

**2026-09-24。** Issue #34 で `SavedRecordWithMeta` / `EditingRecordWithMeta` を
用意したが、`event.ts` は相変わらず素の `SavedRecord` / `EditingRecord` で
宣言していた。利用側は詳細画面の `event.record` から `$id.value` を読むたびに
`SavedRecordWithMeta` へ `as` でごまかしていた。

**実測では、作成画面系以外のイベントの `record` はすべてのサンプルで
`$id`（`__ID__`）と `$revision`（`__REVISION__`）を string で持っていた。**
`index.show` は `records` の 1 件ずつ（PC 8 件 / モバイル 6 件）まで見た。
持たないのは作成画面系（`create.show` / `create.change.*` / `create.submit`）だけ。
事実として持つと分かっているものを、型が「持たないかもしれない」と言っていた。

**決定**: 次のイベントの `record` を `*WithMeta` にする。作成画面系は変えない。

| 型 | イベント |
|---|---|
| `SavedRecordWithMeta` | `detail.show` / `print.show` / `index.edit.show` / `submit.success` / `detail.delete.submit` / `index.delete.submit` / `process.proceed` / `index.show` の `records` |
| `EditingRecordWithMeta` | `edit.show`（モバイル）/ `edit.change.*` / `edit.submit` / `index.edit.change.*` / `index.edit.submit` |

`WithMeta` は素の型に代入できるので、`event.record` を読む側は壊れない。
**壊れうるのは、`event.record` に素の `SavedRecord` / `EditingRecord` 型の値を
丸ごと代入して返すコード**（`$id` を持たない型を代入することになる）。

**捨てた選択肢: 実行時の型ガード**（`isSavedRecordWithMeta` を足す案、PR #62）。
実測で必ず持つと分かっている文脈では、ガードは「起こり得ない else」を利用者に
書かせ、実行時のコストも払わせる。型で言えることは型で言う。
`guard/record.ts` の全 export がフィールド単位の型述語であるという
`guard.test-d.ts` の不変条件も、この 2 つだけ除外しないと保てなかった。

**ガードが要る場面は別にある**: `kintone.app.record.get()` は作成画面でも
編集画面でも `EditingRecord` を返し、共用ハンドラーでは編集画面かどうかが
型からは決まらない。そこは実行時に見るしかない。必要になったら足す。

`event.test-d.ts` に、上のイベントすべてで `record.$id.value` が `string` に
なること、作成画面系が `SavedRecordWithMeta` を満たさないことを足した。
`DetailShowEvent` と `IndexShowEvent` を素の型に戻す変異で、追加したテストが
落ちることを確かめた。`test/dist/consumer.ts` にも `.d.ts` 出力後の確認を足した。

## 2026-10 の JS API 更新（テーブルの行ボタン）に追随する

**2026-10-10。** kintone の JS API 更新
（<https://cybozu.dev/ja/kintone/news/api-updates/2026-10/>）で、
テーブルフィールドの行の追加／削除ボタンを操作する 4 組（PC・モバイルで 8 個）が
公式一覧に追加された。

```
kintone.app.record.showAddTableRowButtons(fieldCode, state)
kintone.app.record.getAddTableRowButtonsDisplayState(fieldCode)
kintone.app.record.showDeleteTableRowButtons(fieldCode, state)
kintone.app.record.getDeleteTableRowButtonsDisplayState(fieldCode)
```

（モバイル版 `kintone.mobile.app.record.*` も同形。）

既存の `showActionButton(action, state)` / `getActionButtonDisplayState(action)`
と同じ骨格（第 1 引数に文字列、以降は `Api.Visibility` の show/get 対）なので、
そのまま倣って `src/kintone.ts` に足した。**根拠はドキュメントで、未実測**
（このファイル自体がドキュメント由来の API を含む前提は「実測とドキュメントを
混ぜない」の通り）。

`test/jsApi.ts` の `OFFICIAL_JS_APIS` に 8 個追加し、166 → 174 個になった。
`jsApi.test.ts` の「数が合っている」が自動で縛るので、個別のテストは足していない。
