import type { EventOf, KintoneEventName } from "./types/event.js";
import type { Api } from "./types/jsApi.js";
import type { EditingRecord, SetRecord } from "./types/record.js";

/**
 * `Api` はルート（`tsumekae`）からも出ているが、`tsumekae/kintone` だけを
 * import している利用者がグローバルの戻り値の中身（`kintone.ProxyResponse` など）を
 * 参照するには、もう1つ import 文が要る形になっていた（Issue #59）。
 * 同じ入口から両方触れるように、ここでも export する。
 */
export type { Api } from "./types/jsApi.js";

/**
 * kintone のグローバルオブジェクトの型宣言。
 *
 * ## 何を宣言しているか
 *
 * 公式ドキュメントの
 * [JavaScript API 一覧](https://cybozu.dev/ja/kintone/docs/js-api/)に
 * 載っているものすべて（2026-10-10 時点で 174 個）。
 *
 * `@kintone/dts-gen` は 51 個しか宣言していない（公式一覧の 31%）。
 * その 51 個は公式一覧の真部分集合なので、**dts-gen は要らない**。
 *
 * ## dts-gen に載せない理由
 *
 * `/// <reference types="@kintone/dts-gen/kintone" />` で土台にする案を試して捨てた。
 * 名前空間がマージされると、同名の関数が**オーバーロードとして併存**する。
 * 戻り値（`record.get()`）はこちらが勝つが、
 * **引数の位置では dts-gen の緩い宣言が拾ってしまう**。
 *
 * ```ts
 * kintone.app.record.set({ でたらめ: 1 });   // dts-gen の set(record: any) が通す
 * kintone.events.on("app.record.detial.show", (e) => e);  // タイポも通る
 * ```
 *
 * 「読みは厳しく、書きは無検査」になる。詳しくは
 * `docs/DECISIONS.md` の「dts-gen を土台にしない」。
 *
 * ## 根拠が 2 種類ある
 *
 * | 根拠 | 対象 |
 * |---|---|
 * | **実測**（`fixtures/measured.json`） | `events.on` の event、`record.get()` / `set()` のレコード |
 * | **公式ドキュメント** | それ以外すべて。返る値の形は確かめていない |
 *
 * ドキュメント由来の型は `Api` 名前空間（`src/types/jsApi.ts`）に置いてある。
 * 実測とドキュメントを混ぜないため。
 *
 * dts-gen の `fieldTypes` 名前空間は引き継がない。
 * 全フィールドに `disabled?` / `error?` を持たせているが、
 * 実測ではどちらも読み取りには存在しない（84 サンプルで 0 件）。
 *
 * ## 要素の型は `HTMLElement`
 *
 * ドキュメントは「要素」としか書いていないが、`HTMLElement` にしてある。
 * dts-gen がそうしており、既存のカスタマイズは `.style` や `.appendChild` を
 * 直接触っているため。`Element` に広げると、その呼び出しが全部落ちる。
 */

declare global {
	namespace kintone {
		// =====================================================================
		// イベント（実測）
		// =====================================================================
		namespace events {
			/**
			 * イベントハンドラを登録する。
			 *
			 * イベント名のリテラルから event の形が決まる。
			 * 配列で複数渡した場合、handler の引数はそれらのユニオンになる。
			 *
			 * ```ts
			 * kintone.events.on("app.record.detail.show", (event) => {
			 *   event.record;    // SavedRecord
			 *   event.recordId;  // number
			 *   return event;
			 * });
			 *
			 * kintone.events.on("app.record.edit.submit", (event) => {
			 *   // 保存を止めるときは error を設定して返す
			 *   return { ...event, error: "保存できません" };
			 * });
			 * ```
			 *
			 * マップに無いイベント名も渡せる。
			 * 閉じたマップだけにすると、kintone が新しいイベントを追加したときに
			 * ライブラリの更新を待つまで使えなくなるため。
			 * その場合 event は緩い型になる。
			 *
			 * **根拠**: 実測（レコード系イベント 30 種）。
			 */
			function on<Name extends KintoneEventName>(
				event: Name | Name[],
				// 戻り値の void は必要。undefined にすると `(event) => { ... }`
				// （推論結果が void）を渡せなくなる（tsc で確認済み: TS2345）
				handler: (
					event: EventOf<Name>,
					// biome-ignore lint/suspicious/noConfusingVoidType: 何も返さないハンドラを許すために必要
				) => EventOf<Name> | Promise<EventOf<Name>> | void,
			): void;
			function on(
				event: (string & {}) | (string & {})[],
				handler: (event: EventOf<string>) => unknown,
			): void;

			function off<Name extends KintoneEventName>(
				event: Name | Name[],
				handler: (event: EventOf<Name>) => unknown,
			): boolean;
			function off(event: string | string[]): boolean;
			function off(): boolean;
		}

		// =====================================================================
		// REST API の実行（ドキュメント）
		// =====================================================================

		/**
		 * kintone の REST API を呼ぶ。
		 *
		 * コールバックを渡さなければ Promise が返る。
		 * 渡した場合の戻りは undefined。
		 */
		function api(
			pathOrUrl: string,
			method: Api.HttpMethod,
			params: object,
		): Promise<unknown>;
		function api(
			pathOrUrl: string,
			method: Api.HttpMethod,
			params: object,
			success: (response: unknown) => void,
			failure?: (error: unknown) => void,
		): void;

		namespace api {
			/** REST API の URL を組み立てる */
			function url(path: string, detectGuestSpace?: boolean): string;
			/** GET 用に、クエリ文字列まで含めた URL を組み立てる */
			function urlForGet(
				path: string,
				params?: object,
				detectGuestSpace?: boolean,
			): string;
			/** 同時実行数の上限と、いま走っている数 */
			function getConcurrencyLimit(): Promise<{
				limit: number;
				running: number;
			}>;
		}

		/** CSRF トークン。最終アクセスから 86,400 秒で切れる */
		function getRequestToken(): string;

		// =====================================================================
		// 外部 API の実行（ドキュメント）
		// =====================================================================

		function proxy(
			url: string,
			method: Api.HttpMethod,
			headers: Record<string, string>,
			data: object | string,
		): Promise<Api.ProxyResponse>;
		function proxy(
			url: string,
			method: Api.HttpMethod,
			headers: Record<string, string>,
			data: object | string,
			success: (
				body: string,
				status: number,
				headers: Record<string, string>,
			) => void,
			failure?: (error: string) => void,
		): void;

		namespace proxy {
			function upload(
				url: string,
				method: "POST" | "PUT",
				headers: Record<string, string>,
				data: Api.ProxyUploadData,
			): Promise<Api.ProxyResponse>;
			function upload(
				url: string,
				method: "POST" | "PUT",
				headers: Record<string, string>,
				data: Api.ProxyUploadData,
				success: (
					body: string,
					status: number,
					headers: Record<string, string>,
				) => void,
				failure?: (error: string) => void,
			): void;
		}

		// =====================================================================
		// アプリ・レコード（PC）
		// =====================================================================
		namespace app {
			/** アプリ ID。アプリの画面以外では null */
			function getId(): number | null;
			/** アプリの設定。**根拠はドキュメント** */
			function get(): Promise<Api.AppInfo>;
			/** フォームのフィールド設定。**レコードの値ではない** */
			function getFormFields(): Promise<Record<string, Api.FormField>>;
			/** フォームの配置 */
			function getFormLayout(): Promise<Api.FormLayout>;
			/** テスト環境かどうか */
			function isTestEnvironment(): Promise<boolean>;
			/** メンテナンス中かどうか */
			function isMaintenanceMode(): Promise<boolean>;
			/** アプリのアイコン URL。引数はアプリ ID の配列 */
			function getIcons(
				apps: number[],
			): Promise<{ app: number; url: string }[]>;
			/** アプリの操作権限 */
			function getPermissions(): Promise<{
				addRecord: boolean;
				editApp: boolean;
			}>;
			/** カテゴリーの設定 */
			function getCategories(): Promise<Api.Categories>;
			/** プロセス管理の設定 */
			function getStatus(): Promise<Api.ProcessStatus>;
			/** いま表示している一覧 */
			function getView(): Promise<Api.View>;
			/** 一覧の一覧 */
			function getViews(): Promise<
				Pick<Api.View, "type" | "builtinType" | "name" | "id">[]
			>;
			/** グラフの一覧 */
			function getReports(): Promise<Api.Report[]>;
			/** 絞り込み条件だけのクエリ */
			function getQueryCondition(): string | null;
			/** 並び順・件数まで含んだクエリ */
			function getQuery(): string | null;
			/**
			 * ルックアップの参照先アプリ ID。
			 *
			 * **ドキュメントは「数値」。dts-gen は `string | null` にしている。**
			 * 実測していないのでドキュメントに従う（DECISIONS）。
			 */
			function getLookupTargetAppId(fieldCode: string): number | null;
			/** 関連レコード一覧の参照先アプリ ID。上と同じ食い違いがある */
			function getRelatedRecordsTargetAppId(fieldCode: string): number | null;
			/** 一覧画面のフィールドの要素。列の数だけ返る */
			function getFieldElements(fieldCode: string): HTMLElement[] | null;
			/** 一覧画面のヘッダーの空白 */
			function getHeaderSpaceElement(): HTMLElement | null;
			/** 一覧画面のメニューの右側 */
			function getHeaderMenuSpaceElement(): HTMLElement | null;
			/** アプリの説明を開く / 閉じる */
			function showDescription(state: "OPEN" | "CLOSED"): Promise<void>;
			/** アプリの説明の表示状態 */
			function getDescriptionDisplayState(): Promise<
				"OPEN" | "CLOSED" | "HIDDEN"
			>;

			function showAddRecordButton(state: Api.Visibility): Promise<void>;
			function getAddRecordButtonDisplayState(): Promise<Api.Visibility>;
			function showAppSettingsButton(state: Api.Visibility): Promise<void>;
			function getAppSettingsButtonDisplayState(): Promise<Api.Visibility>;
			function showFilterButton(state: Api.Visibility): Promise<void>;
			function getFilterButtonDisplayState(): Promise<Api.Visibility>;
			function showOptionsButton(state: Api.Visibility): Promise<void>;
			function getOptionsButtonDisplayState(): Promise<Api.Visibility>;
			function showReportButton(state: Api.Visibility): Promise<void>;
			function getReportButtonDisplayState(): Promise<Api.Visibility>;
			function showViewAndReportSelector(state: Api.Visibility): Promise<void>;
			function getViewAndReportSelectorDisplayState(): Promise<Api.Visibility>;
			/** 一覧の選択肢を個別に出し分ける。キーは一覧 ID */
			function showViewSelectorItems(
				config: Record<string, Api.Visibility>,
			): Promise<void>;
			function getViewSelectorItemsDisplayState(): Promise<
				Record<string, Api.Visibility>
			>;
			/** グラフの選択肢を個別に出し分ける。キーはグラフ ID */
			function showReportSelectorItems(
				config: Record<string, Api.Visibility>,
			): Promise<void>;
			function getReportSelectorItemsDisplayState(): Promise<
				Record<string, Api.Visibility>
			>;
			/** 一覧の見た目。"DEFAULT" で元に戻す */
			function setRecordListStyle(
				config: Api.RecordListStyleConfig,
			): Promise<void>;
			function getRecordListStyle(): Promise<Api.RecordListStyle>;

			namespace record {
				/** レコード ID。一覧画面や作成画面では null */
				function getId(): number | null;

				/**
				 * 画面が保持しているレコードを取得する。
				 *
				 * **`kintone.events.on` のハンドラ内では動作しない**（null を返す）。
				 * ボタンのクリックなど、イベント処理の外から呼ぶ。
				 *
				 * 返るのは編集中のフォームの状態なので `EditingRecord`。
				 * 値が一度も設定されたことのないフィールドは `value` が undefined になる。
				 * 一覧画面では null を返す。
				 *
				 * **根拠**: 実測。
				 */
				function get(): { record: EditingRecord } | null;

				/**
				 * 画面のレコードを書き換える。
				 *
				 * **`kintone.events.on` のハンドラ内では動作しない**。
				 *
				 * `disabled` と `error` はここでのみ意味を持つ。
				 * 設定しても `get()` では返らない（実測）。
				 *
				 * **根拠**: 実測。
				 */
				function set(record: { record: KintoneSetRecord }): void;

				/** レコードの操作権限 */
				function getPermissions(): Promise<{
					editRecord: boolean;
					deleteRecord: boolean;
				}>;
				/** フィールドごとの閲覧・編集権限 */
				function getFieldPermissions(): Promise<
					Record<string, { readField: boolean; editField: boolean }>
				>;
				/** プロセス管理の履歴 */
				function getStatusHistory(
					offset?: number,
					limit?: number,
				): Promise<Api.StatusHistory[]>;
				/** 実行できるアクション */
				function getActions(): Promise<{ name: string; id: string }[]>;
				/** 実行できるステータスの操作 */
				function getStatusActions(): Promise<Api.StatusAction[]>;
				/** いまの作業者 */
				function getAssignees(): Promise<Api.Assignee[]>;

				function getHeaderMenuSpaceElement(): HTMLElement | null;
				function getFieldElement(fieldCode: string): HTMLElement | null;
				function getSpaceElement(id: string): HTMLElement | null;
				function setFieldShown(fieldCode: string, isShown: boolean): void;
				function isFieldVisible(fieldCode: string): Promise<boolean>;
				function setGroupFieldOpen(fieldCode: string, isOpen: boolean): void;
				function isGroupFieldOpen(fieldCode: string): Promise<boolean>;
				/** フィールドの見た目。"DEFAULT" で元に戻す */
				function setFieldStyle(
					fieldCode: string,
					config: Api.FieldStyleConfig,
				): Promise<void>;
				function getFieldStyle(fieldCode: string): Promise<Api.FieldStyle>;

				function showEditRecordButton(state: Api.Visibility): Promise<void>;
				function getEditRecordButtonDisplayState(): Promise<Api.Visibility>;
				function showDuplicateRecordButton(
					state: Api.Visibility,
				): Promise<void>;
				function getDuplicateRecordButtonDisplayState(): Promise<Api.Visibility>;
				function showChangeAssigneeButton(state: Api.Visibility): Promise<void>;
				function getChangeAssigneeButtonDisplayState(): Promise<Api.Visibility>;
				function showPager(state: Api.Visibility): Promise<void>;
				function getPagerDisplayState(): Promise<Api.Visibility>;
				/** サイドバー。**引数が VISIBLE / HIDDEN ではない** */
				function showSideBar(
					state: "OPEN" | "CLOSED" | "COMMENTS" | "HISTORY",
				): Promise<void>;
				function getSideBarDisplayState(): Promise<
					"CLOSED" | "COMMENTS" | "HISTORY" | "HIDDEN"
				>;
				/** アクションボタン。**アクション名を第 1 引数に取る** */
				function showActionButton(
					action: string,
					state: Api.Visibility,
				): Promise<void>;
				function getActionButtonDisplayState(
					action: string,
				): Promise<Api.Visibility>;
				/** ステータスの操作ボタン。**アクション名を第 1 引数に取る** */
				function showStatusActionButton(
					action: string,
					state: Api.Visibility,
				): Promise<void>;
				function getStatusActionButtonDisplayState(
					action: string,
				): Promise<Api.Visibility>;
				/**
				 * テーブルの行の追加ボタン。**フィールドコードを第 1 引数に取る**。
				 * 2026-10 の JS API 更新で追加（ドキュメント根拠、未実測）
				 */
				function showAddTableRowButtons(
					fieldCode: string,
					state: Api.Visibility,
				): Promise<void>;
				function getAddTableRowButtonsDisplayState(
					fieldCode: string,
				): Promise<Api.Visibility>;
				/** テーブルの行の削除ボタン。理由は {@link showAddTableRowButtons} と同じ */
				function showDeleteTableRowButtons(
					fieldCode: string,
					state: Api.Visibility,
				): Promise<void>;
				function getDeleteTableRowButtonsDisplayState(
					fieldCode: string,
				): Promise<Api.Visibility>;
			}
		}

		// =====================================================================
		// モバイル
		// =====================================================================
		namespace mobile {
			namespace app {
				function getId(): number | null;
				function getFieldElements(fieldCode: string): HTMLElement[] | null;
				function getHeaderSpaceElement(): HTMLElement | null;
				function getQueryCondition(): string | null;
				function getQuery(): string | null;
				function getLookupTargetAppId(fieldCode: string): number | null;
				function getRelatedRecordsTargetAppId(fieldCode: string): number | null;
				function showAddRecordButton(state: Api.Visibility): Promise<void>;
				function getAddRecordButtonDisplayState(): Promise<Api.Visibility>;
				function showFilterButton(state: Api.Visibility): Promise<void>;
				function getFilterButtonDisplayState(): Promise<Api.Visibility>;
				function showOptionsButton(state: Api.Visibility): Promise<void>;
				function getOptionsButtonDisplayState(): Promise<Api.Visibility>;
				/** モバイルは一覧とグラフの選択肢が別々 */
				function showViewSelector(state: Api.Visibility): Promise<void>;
				function getViewSelectorDisplayState(): Promise<Api.Visibility>;
				function showReportSelector(state: Api.Visibility): Promise<void>;
				function getReportSelectorDisplayState(): Promise<Api.Visibility>;
				function showViewSelectorItems(
					config: Record<string, Api.Visibility>,
				): Promise<void>;
				function getViewSelectorItemsDisplayState(): Promise<
					Record<string, Api.Visibility>
				>;
				function showReportSelectorItems(
					config: Record<string, Api.Visibility>,
				): Promise<void>;
				function getReportSelectorItemsDisplayState(): Promise<
					Record<string, Api.Visibility>
				>;
				function setRecordListStyle(
					config: Api.RecordListStyleConfig,
				): Promise<void>;
				function getRecordListStyle(): Promise<Api.RecordListStyle>;

				namespace record {
					function getId(): number | null;
					/** **根拠**: 実測。PC と同じ形（モバイルの編集画面も Editing） */
					function get(): { record: EditingRecord } | null;
					/** **根拠**: 実測 */
					function set(record: { record: KintoneSetRecord }): void;
					function getFieldElement(fieldCode: string): HTMLElement | null;
					function getSpaceElement(id: string): HTMLElement | null;
					function setFieldShown(fieldCode: string, isShown: boolean): void;
					function isFieldVisible(fieldCode: string): Promise<boolean>;
					function setGroupFieldOpen(fieldCode: string, isOpen: boolean): void;
					function isGroupFieldOpen(fieldCode: string): Promise<boolean>;
					function setFieldStyle(
						fieldCode: string,
						config: Api.FieldStyleConfig,
					): Promise<void>;
					function getFieldStyle(fieldCode: string): Promise<Api.FieldStyle>;
					function showEditRecordButton(state: Api.Visibility): Promise<void>;
					function getEditRecordButtonDisplayState(): Promise<Api.Visibility>;
					function showPager(state: Api.Visibility): Promise<void>;
					function getPagerDisplayState(): Promise<Api.Visibility>;
					function showActionButton(
						action: string,
						state: Api.Visibility,
					): Promise<void>;
					function getActionButtonDisplayState(
						action: string,
					): Promise<Api.Visibility>;
					function showStatusActionButton(
						action: string,
						state: Api.Visibility,
					): Promise<void>;
					function getStatusActionButtonDisplayState(
						action: string,
					): Promise<Api.Visibility>;
					/** 理由は PC 版 {@link showAddTableRowButtons} と同じ */
					function showAddTableRowButtons(
						fieldCode: string,
						state: Api.Visibility,
					): Promise<void>;
					function getAddTableRowButtonsDisplayState(
						fieldCode: string,
					): Promise<Api.Visibility>;
					function showDeleteTableRowButtons(
						fieldCode: string,
						state: Api.Visibility,
					): Promise<void>;
					function getDeleteTableRowButtonsDisplayState(
						fieldCode: string,
					): Promise<Api.Visibility>;
				}
			}

			namespace portal {
				function getContentSpaceElement(): HTMLElement | null;
			}
			namespace space {
				namespace portal {
					function getContentSpaceElement(): HTMLElement | null;
				}
			}

			/** モバイルは確認ダイアログがボトムシートになる */
			function showConfirmBottomSheet(
				config: Api.ConfirmDialogConfig,
			): Promise<Api.DialogAction>;
			function createBottomSheet(config: Api.DialogConfig): Promise<Api.Dialog>;
			function showNotification(
				type: "ERROR" | "SUCCESS" | "INFO",
				message: string,
			): Promise<void>;
			function showLoading(state: Api.Visibility): Promise<void>;
		}

		// =====================================================================
		// プラグイン
		// =====================================================================
		namespace plugin {
			namespace app {
				/** 保存した設定。利用できる画面の外では null */
				function getConfig(pluginId: string): Record<string, string> | null;
				function setConfig(
					config: Record<string, string>,
					success?: () => void,
				): void;
				function getProxyConfig(
					url: string,
					method: string,
				): { headers: Record<string, string>; data: object } | null;
				function setProxyConfig(
					url: string,
					method: Api.HttpMethod,
					headers: Record<string, string>,
					data: object,
					success?: () => void,
				): void;

				function proxy(
					pluginId: string,
					url: string,
					method: Api.HttpMethod,
					headers: Record<string, string>,
					data: object | string,
				): Promise<Api.ProxyResponse>;
				function proxy(
					pluginId: string,
					url: string,
					method: Api.HttpMethod,
					headers: Record<string, string>,
					data: object | string,
					success: (
						body: string,
						status: number,
						headers: Record<string, string>,
					) => void,
					failure?: (error: string) => void,
				): void;

				namespace proxy {
					function upload(
						pluginId: string,
						url: string,
						method: "POST" | "PUT",
						headers: Record<string, string>,
						data: Api.ProxyUploadData,
					): Promise<Api.ProxyResponse>;
					function upload(
						pluginId: string,
						url: string,
						method: "POST" | "PUT",
						headers: Record<string, string>,
						data: Api.ProxyUploadData,
						success: (
							body: string,
							status: number,
							headers: Record<string, string>,
						) => void,
						failure?: (error: string) => void,
					): void;
				}
			}
		}

		// =====================================================================
		// ポータル・スペース・システム・ライセンス
		// =====================================================================
		namespace portal {
			function getContentSpaceElement(): HTMLElement | null;
		}

		namespace space {
			function get(): Promise<{ id: string; name: string; isGuest: boolean }>;
			function getPermissions(): Promise<{ administration: boolean }>;
			namespace portal {
				function getContentSpaceElement(): HTMLElement | null;
			}
		}

		namespace system {
			function getAvailableFeatures(): Promise<{
				space: { enabled: boolean };
				guestSpace: { enabled: boolean };
				people: { enabled: boolean };
				message: { enabled: boolean };
			}>;
			function getPermissions(): Promise<{ administration: boolean }>;
		}

		namespace license {
			function isTrial(): Promise<boolean>;
			function getSubscriptionPlan(): Promise<"STANDARD" | "WIDE">;
		}

		// =====================================================================
		// 全体情報
		// =====================================================================
		namespace user {
			/** 引数を省くとログインユーザー自身 */
			function getCustomFields(code?: string): Promise<Api.CustomField[]>;
			function getGroups(
				code?: string,
			): Promise<{ id: string; code: string; name: string }[]>;
			function getOrganizations(code?: string): Promise<Api.UserOrganization[]>;
			/** 引数はログイン名の配列 */
			function getIcons(
				users: string[],
			): Promise<{ user: string; url: string }[]>;
		}

		/** ログインユーザー。**これだけ同期で返る** */
		function getLoginUser(): Api.LoginUser;
		function getPageType(): Promise<Api.PageType>;
		/** 1 は旧デザインとモバイル、2 は新デザイン */
		function getUiVersion(): 1 | 2;
		function getAvailableServices(): Promise<{
			garoon: boolean;
			office: boolean;
			mailwise: boolean;
		}>;
		function getDomain(): Promise<{ subdomain: string; baseDomain: string }>;
		function getAvailableApiTypes(): Promise<("CORE" | "WIDE")[]>;
		function isAccessWithClientCertificateAuthentication(): Promise<boolean>;
		function isMobileApp(): Promise<boolean>;
		function isMobilePage(): Promise<boolean>;
		function getUserPreference(): Promise<Api.UserPreference>;
		function isUsersAndSystemAdministrator(): Promise<boolean>;
		function isRevampedUI(): Promise<boolean>;

		// =====================================================================
		// ダイアログ・通知・ページ操作
		// =====================================================================
		function showConfirmDialog(
			config: Api.ConfirmDialogConfig,
		): Promise<Api.DialogAction>;
		function createDialog(config: Api.DialogConfig): Promise<Api.Dialog>;
		function showNotification(
			type: "ERROR" | "SUCCESS" | "INFO",
			message: string,
		): Promise<void>;
		function showLoading(state: Api.Visibility): Promise<void>;
		function buildPageUrl(
			page: Api.PageName,
			params: {
				appId?: string;
				recordId?: string;
				viewId?: string;
				reportId?: string;
				spaceId?: string;
				threadId?: string;
				userCode?: string;
			},
		): Promise<string>;
		function setKeyboardShortcuts(config: Api.KeyboardShortcuts): Promise<void>;
		function getKeyboardShortcuts(): Promise<Record<string, boolean>>;

		/** プラグインの JavaScript の中でだけ値が入る */
		const $PLUGIN_ID: string;
	}

	/**
	 * `kintone.app.record.set()` に渡せるレコード。
	 *
	 * 実体は `tsumekae` のルートから出ている {@link SetRecord}。
	 * ここではグローバルな別名として置くだけで、定義を二重に持たない
	 * （自前の `kintone.d.ts` を持つプロジェクトは、
	 * ルートから `SetRecord` を import して同じ型を使える）。
	 */
	type KintoneSetRecord = SetRecord;
}

// このファイルはグローバル宣言のみを持つ。
// 先頭の import があるためモジュールとして扱われ、declare global が有効になる。
//
// index.ts からは import しない。ライブラリが利用者のグローバルスコープを
// 勝手に書き換えないため。使う側が明示的に取り込む。
//
//   import "tsumekae/kintone";
//
// サーバサイドで toRestWrite などだけを使う利用者に kintone グローバルを
// 生やすと、実行時に存在しないものをコンパイルが通してしまう。
