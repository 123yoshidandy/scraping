# page-watcher

Webページが指定した条件を満たしたことを検知して通知する汎用監視ツール。

EC サイトの在庫復活、イベントの先着応募受付開始、チケット販売開始、告知ページの更新など、「ページが特定の状態になったら知りたい」というユースケース全般に使える。GitHub Actions の cron で定期実行する想定。

- 検知・通知のみ（自動購入・自動応募などのアクションは行わない）
- 通知は状態遷移ベース（不成立 → 成立 の変化時に1回だけ。毎回は通知しない。一覧の新着を検知する `items_added` は新着があるたび）
- 通知先はプラガブル（現在はコンソール出力＋GitHub Actions ジョブサマリー＋Discord Webhook。Slack/LINE 等は後から追加可能）

## 仕組み

1. `targets.json` に並べたターゲットを Playwright (Chromium) で順番に開く
2. 各ターゲットの `triggerWhen` ルールで「条件成立 (matched) / 不成立 (unmatched) / 判定不能 (error)」を判定
3. 前回の状態（`.state/state.json`）と比較し、**不成立 → 成立に変化したときだけ**通知（`items_added` は前回なかった項目があるときだけ）
4. 状態を保存（GitHub Actions 上では `actions/cache` で実行をまたいで永続化）

## セットアップ（ローカル）

```bash
npm install
npx playwright install chromium
```

## 実行

```bash
npm run check          # targets.json を使ってチェック
npm run typecheck      # 型チェックのみ
npm test               # ユニットテスト（node:test。ブラウザは起動しない）
```

環境変数:

| 変数 | 説明 |
| --- | --- |
| `TARGETS_PATH` | 設定ファイルのパスを上書き（default: `targets.json`） |
| `FAIL_ON_TRIGGER=1` | 条件成立を検知したら exit 1 にする（GitHub の失敗通知メールを暫定通知として使う用） |
| `DISCORD_WEBHOOK_URL` | Discord の Incoming Webhook URL。設定時は条件成立を Discord に投稿する（「Discord 通知の設定」を参照） |
| `GITHUB_STEP_SUMMARY` | GitHub Actions が自動設定。設定時はジョブサマリーにレポートと通知バナーを出力 |

## targets.json の書き方

```jsonc
[
  {
    "name": "example-restock",              // 必須・一意。stateのキー（リネームすると状態リセット）
    "description": "〇〇の在庫復活",          // 任意。通知文言に使われる
    "url": "https://example.com/item/123",  // 必須
    "triggerWhen": {                         // 必須。この条件が成立したら通知
      "type": "text_absent",                 // selector_exists | selector_absent | text_present | text_absent | items_added
      "text": "SOLD OUT"                     // text系ルールで必須（selector系・items_added では selector が必須）
      // "keyAttribute": "data-id",          // items_added で必須。項目を一意に識別する属性名
      // "labelSelector": ".title",          // items_added で任意。項目内で表示名を取る相対セレクタ
      // "max": 7200,                        // number_at_most で必須。この値以下なら成立
      // "min": 1,                           // number_at_most で任意。これ未満は無視（default: 1）
      // "rules": []                         // all_of で必須。1件以上の子ルール
    },
    "requireSelector": "h1.product-title",  // 強く推奨（後述）
    "enabled": true,                         // 任意。false で一時停止（状態は保持される）
    "timeoutMs": 30000,                      // 任意。ナビゲーションのタイムアウト
    "waitUntil": "domcontentloaded",         // 任意。load | domcontentloaded | networkidle
    "extraWaitMs": 0,                        // 任意。JSレンダリング待ちの追加待機
    "userAgent": "...",                      // 任意。デフォルトは一般的なデスクトップChromeのUA
    "locale": "ja-JP",                       // 任意
    "timezoneId": "Asia/Tokyo"               // 任意
  }
]
```

### ルールの種類と判定セマンティクス

| type | 成立条件 | 備考 |
| --- | --- | --- |
| `selector_exists` | `selector` に**可視の**要素が1つ以上ある | 非表示の要素はカウントしない。最大10秒待ってから不成立と判定（遅いレンダリング対策） |
| `selector_absent` | `selector` に可視の要素がない | ⚠️ `requireSelector` 併用を強く推奨 |
| `text_present` | ページの可視テキストに `text` が含まれる | 大文字小文字無視・空白正規化した部分一致。最大10秒待つ |
| `text_absent` | ページの可視テキストに `text` が含まれない | ⚠️ `requireSelector` 併用を強く推奨 |
| `items_added` | `selector` の可視要素のうち、`keyAttribute` の値が過去7日間に観測されていない項目が1件以上ある | 一覧ページの新着検知用。初回は基準取得のみで通知しない。可視要素が0件なら error。⚠️ `requireSelector` 併用を強く推奨 |
| `number_at_most` | `selector` の最初の可視要素のテキストから読み取った数値が `min` 以上 `max` 以下 | 価格の上限判定用。全角数字・通貨記号・桁区切りを解釈する（「￥5,940」→ 5940）。**要素が現れなければ不成立**（価格非表示＝購入不可）。要素はあるのに数値が読めなければ error |
| `all_of` | `rules` の子ルールがすべて成立 | 「価格が定価以下」かつ「カートに入れられる」のような複合条件用。子には `items_added` と `all_of` は書けない。1つでも不成立なら残りは評価しない |

**⚠️ absent系ルールには `requireSelector` を必ず併用すること。**
absent系は「無いこと」が成立条件のため、bot遮断ページや白紙ページでも成立してしまう。`requireSelector`（商品タイトルなど、正しいページなら必ず存在する要素）が見つからない場合は判定不能 (error) 扱いになり、誤通知を防げる。

### ユースケース別の設定例

```jsonc
// ECの在庫復活（「SOLD OUT」表記が消えたら通知）
{ "triggerWhen": { "type": "text_absent", "text": "SOLD OUT" }, "requireSelector": "h1.product-title" }

// ECの在庫復活（「品切れ」ラベルの要素が消えたら通知。ボタン文言が在庫有無で変わらないサイト向け）
{ "triggerWhen": { "type": "selector_absent", "selector": ".price-container p.stock" }, "requireSelector": ".price-container .price" }

// イベントの先着応募受付開始（「受付中」が出たら通知）
{ "triggerWhen": { "type": "text_present", "text": "受付中" } }

// 応募ボタンの出現で判定する場合
{ "triggerWhen": { "type": "selector_exists", "selector": "a.apply-button" } }

// 販売開始前ページの変化（「Coming Soon」が消えたら通知）
{ "triggerWhen": { "type": "text_absent", "text": "Coming Soon" }, "requireSelector": "main" }

// 一覧ページに新しい項目が追加されたら通知（再入荷一覧、新着告知、求人一覧など）
{
  "triggerWhen": { "type": "items_added", "selector": "ul.list > li", "keyAttribute": "data-id", "labelSelector": ".title a" },
  "requireSelector": "ul.list"
}

// 定価以下で購入できるようになったら通知（転売価格では通知しない）
// 「価格が表示されている」だけでは購入できるとは限らないため、購入ボタンの存在と組み合わせる
{
  "triggerWhen": { "type": "all_of", "rules": [
    { "type": "number_at_most", "selector": ".price", "max": 7300 },
    { "type": "selector_exists", "selector": "#add-to-cart-button" }
  ]},
  "requireSelector": "h1.product-title"
}
```

## ストア別のレシピ（同梱の targets.json で使用）

「定価より高い価格では通知しない」ため、どのストアでも **価格の上限判定と購入可否の判定を `all_of` で組み合わせる**。価格が表示されていても購入できない状態（招待販売・受注期間外など）があるため、価格だけでは判定できない。

判定が速く終わるよう、**購入できないことが即座に分かる条件を先頭に置く**（`text_absent` / `selector_absent` は待たずに判定するため、不成立ならその時点で終わる）。

### Amazon.co.jp

| 用途 | セレクタ・文言 |
| --- | --- |
| 価格 | `#corePrice_feature_div .a-price-whole` |
| 購入可否 | `#add-to-cart-button` の存在 |
| 招待販売の除外 | 本文に「招待された方のみ」が無いこと |
| requireSelector | `#productTitle` |

- 人気商品は **招待販売**（価格は表示されるが招待メールを受け取った人しか買えない）になっていることがある。`#availability` に「招待された方のみご購入いただけます」と出るので、この文言で除外する
- 価格はカートボックスの表示価格。転売出品者がカートボックスを取ると高い価格が表示され、上限を超えるので通知されない
- `.a-offscreen` はページ全体に多数あるため使わない。必ず `#corePrice_feature_div` に絞る
- ⚠️ **Amazon の利用規約は「価格などの収集」「ロボット等のデータ収集ツールの使用」を明示的に禁止している**（robots.txt が `/dp/` を許可しているかどうかとは別の話）。また GitHub Actions のIPからは bot 判定でブロックされることがあり、その場合は `requireSelector` が見つからず連続 error（Degraded）になる

### 楽天ブックス

| 用途 | セレクタ・文言 |
| --- | --- |
| 価格 | `p.productPrice span[itemprop=price]` |
| 購入可否 | `div.new_buyButton button.new_addToCart` の存在 |
| 注文不可の除外 | 本文に「ご注文できない商品」が無いこと |
| requireSelector | `#productTitle h1[itemprop=name]` |

- ページの読み込み完了まで **約26秒** かかる。既定のタイムアウト30秒では誤って error になりやすいため、同梱のターゲットは `timeoutMs: 60000` を指定している
- `p.price` は右側のランキング枠にも現れるので、必ず `p.productPrice` に絞る

### ポケモンセンターオンライン

| 用途 | セレクタ・文言 |
| --- | --- |
| 価格 | `.price-container .price` |
| 購入可否 | `.add-to-cart-button.btn:not(.default)` の存在 |
| 購入不可の除外 | `.add-to-cart-button.default` が無いこと |
| requireSelector | `.price-container .price` |

- **カートボタンの文言は在庫の有無にかかわらず「カートに入れる」で変わらない**。購入できないときは `default` クラスが付いて無効化されるので、クラスで判定する
- 「品切れ」表示の有無では判定できない。受注販売のページは品切れ表示が無いのにカートボタンが無効、ということがある
- 抽選販売のページはカートボタン自体が別物になるため、本文の「抽選販売」で除外する
- 色やサイズを選ぶ商品（バリエーションあり）は、選択前はカートボタンに `default` が付く。この判定は単一商品のページ向け

### ヨドバシ.com は監視できない

ヨドバシ.com は **ヘッドレスブラウザからの接続を拒否する**（同じ回線・同じURLでも、ヘッダを揃えた通常のリクエストは 200 を返すのに、Playwright のヘッドレス Chromium は接続を切られる）。本ツールは Playwright で動くため監視できない。

## 状態と通知の挙動

- 状態は `matched` / `unmatched` / `unknown`（初回）で管理し、`unmatched または unknown → matched` の遷移時のみ通知する
  - 追加直後にすでに条件成立しているターゲットは、初回チェックで1回だけ通知される（仕様）
- `error`（タイムアウト、HTTP 4xx/5xx、`requireSelector` 不在など）は判定不能であり、**通知は発火せず、前回の状態も変更しない**。1回だけ自動リトライする
- 3回連続で error になると、ワークフローに warning アノテーションが出て、ジョブサマリーに「Degraded targets」として表示される
- 個別ターゲットの error では exit code は 0 のまま（定期実行が失敗メールでスパムしないため）。exit 1 になるのは設定ファイル不正・未処理クラッシュ・チェック可能ターゲット0件のみ
- 条件成立時と error 時はスクリーンショットを `screenshots/` に保存（Actions では Artifacts にアップロード）
- config から削除（またはリネーム）したターゲットの状態は自動で掃除される
- `number_at_most` で読み取った数値は「観測値: 7,216（上限: 7,300）」の形でログ・ジョブサマリー・通知に出る。条件が成立しなかった実行でも出るので、セレクタが正しく効いているかを確認できる
- `items_added`（一覧の新着検知）は差分ベースで動作する
  - 初回チェック（または state リセット・リネーム直後）は現在の項目集合を基準として保存するだけで **通知しない**
  - 2回目以降、前回までに観測していない項目があれば **そのたびに** 通知する（連続した実行でそれぞれ別の新着があれば両方通知）。通知には項目名・キー・リンクを最大30件列挙し、残りは件数のみ
  - 観測した項目は最後に見た時刻とともに **7日間** 保持する。一時的に一覧から消えて戻ってきた項目は再通知しないが、7日を超えて消えていた項目が戻ると再通知される
  - 7日以上ワークフローを止めて再開すると、全項目が新着として1回通知される
  - 可視要素が0件のときは `error` 扱い（空の一覧かセレクタが古い可能性）。保持している項目は変更しないので、セレクタ修正後に全件が新着扱いになることはない
  - 一覧に残ったままの項目の状態変化（例: 一覧内の「品切れ」表示が消える）は検知できない
  - JS で描画される一覧は、描画完了前に基準を取ると次回に誤検知しうる。`extraWaitMs` や `waitUntil: "networkidle"` で描画完了を待つこと
  - `FAIL_ON_TRIGGER=1` と併用すると、新着があるたびにジョブが失敗する

## GitHub Actions の運用

ワークフローは `.github/workflows/watch.yml`。push すれば cron（デフォルト10分間隔）で動き出す。手動実行は Actions タブ → Page Watch → Run workflow。

### 状態の永続化

リポジトリへの自動コミットを避けるため、`.state/` を `actions/cache` で実行をまたいで永続化している（restore/save 分割 + `if: always()`）。注意点:

- キャッシュは7日間未使用で削除される。cron が回っていれば毎回新規作成されるので問題ないが、**7日以上ワークフローを止めると状態がリセットされ、再開後の初回に通知が1回重複しうる**（自己回復する）

### cron の注意点

- cron は **UTC** 指定（JST − 9時間）。最短間隔は5分
- 実行タイミングはベストエフォートで、**5〜30分の遅延が常態**。`:00` などの人気の分は特に遅れるため、オフセット分（`3,13,23,...`）を使っている
- したがって**先着応募など分単位の勝負には不向き**（遅延は制御できない）
- **リポジトリが60日間更新なしだと schedule は自動停止**する（GitHub からメール警告が来るので、Actions タブから手動で再有効化する）

### 分数クォータ（プライベートリポジトリの場合）

1回のジョブは約2分。無料枠は 2,000分/月。

| 間隔 | 月間消費（概算） | 無料枠 |
| --- | --- | --- |
| 10分 | 約8,600分 | ❌ 大幅超過 |
| 30分 | 約2,900分 | ❌ 超過 |
| 60分 | 約1,450分 | ✅ |

対策: リポジトリをパブリックにする（無料。ただし `targets.json` の監視対象URLが公開される点に注意）か、cron の間隔を広げる。

## Discord 通知の設定

条件成立を Discord のチャンネルに投稿する（`src/notifiers/discord.ts`）。無料で使え、環境変数 `DISCORD_WEBHOOK_URL` を設定したときだけ有効になる。

1. Discord で通知したいチャンネルの「チャンネルの編集」→「連携サービス」→「ウェブフック」→「新しいウェブフック」を作成し、「ウェブフックURLをコピー」する
2. GitHub リポジトリの Settings → Secrets and variables → Actions → New repository secret で、Name を `DISCORD_WEBHOOK_URL`、Secret にコピーした URL を登録する（`watch.yml` の `Run checks` ステップが `env` として渡す）
3. ローカルで試す場合は環境変数として渡す。URL はシェル履歴に残るので、共有マシンでは注意

```bash
DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..." npm run check
```

通知の内容:

- 実行1回につき1メッセージ。1行目（プッシュ通知に表示される）にターゲット名と新着件数、埋め込み（embed）にタイトル・新着項目の一覧・検知時刻
- 埋め込みのタイトルをタップするとターゲットの URL（一覧ページ）が開く。新着項目は最大 20 件をリンク付きで列挙し、残りは件数のみ
- 商品名などに `@everyone` 等が含まれていてもメンション通知が飛ばないよう `allowed_mentions` を空にしている
- 投稿に失敗しても（URL の誤り、Discord 側の障害など）ログに `[notifier:discord] 通知に失敗しました` と出るだけで、ジョブや他の通知先には影響しない。レート制限（HTTP 429）は1回だけ自動で再送する

注意: Webhook URL を知っている人は誰でもそのチャンネルに投稿できる。漏れた可能性がある場合は Discord 側でウェブフックを削除して再発行し、Secret を更新する。

## 通知先の追加方法（Slack/LINE 等）

1. `src/notifiers/` に `Notifier` インターフェース（`src/types.ts`）を実装したクラスを追加（実装例は `src/notifiers/discord.ts`。以下は Slack の雛形）

```ts
import type { Notifier, TriggerEvent } from "../types.js";

export class SlackNotifier implements Notifier {
  readonly name = "slack";
  async notifyTrigger(event: TriggerEvent): Promise<void> {
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    if (!webhookUrl) return; // 環境変数がなければ no-op（StepSummaryNotifier と同じパターン）
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `🔔 条件成立: ${event.target.name}\n${event.target.url}`,
      }),
    });
  }
}
```

2. `src/notifiers/notifier.ts` の `getNotifiers()` に追加
3. Webhook URL 等の秘匿情報は GitHub リポジトリの Settings → Secrets and variables → Actions に登録し、`watch.yml` の `Run checks` ステップで `env` として渡す

## 制限事項

- GitHub ホストランナーは Azure データセンターのIPのため、Cloudflare/Akamai 等の bot 対策が強いサイトは UA に関係なくブロックされることがある（連続 error として可視化される）。本ツールはステルス対策を行わない
- 監視対象サイトの利用規約・robots.txt を確認し、迷惑にならない頻度で使うこと
- 逐次チェック（1ブラウザ・ターゲットごとに新規コンテキスト）のため、10ターゲット程度までを想定。それ以上はチェックの並列化（コンテキスト3〜4並列）を検討
  - 同梱の `targets.json`（有効11件）で1回の実行は約100秒。うち約80秒は楽天ブックス3件のページ読み込み待ち
- 存在系の判定（`selector_exists` / `number_at_most`）は、要素が見つからないとき最大10秒待ってから「不成立」と結論する。不成立が続くターゲットではこの待ち時間が積み上がる
- 同梱の `targets.json` が監視するポケモンセンターオンラインは、利用規約（第6条1項17号・18号）で自動化された手段による在庫情報の取得・スクレイピングを禁止している。Amazon の利用規約も価格情報の収集とロボットによるアクセスを禁止している。これらの設定は個人利用・検知のみの用途で、利用者自身の判断により有効化している

## 将来拡張の候補

- `content_changed` ルール: 指定要素のテキストのハッシュを状態に保存し、変化したら通知（「何が変わるかは分からないが変化を知りたい」ケース向け）
- Slack / LINE (Messaging API) / メール / ntfy.sh などの Notifier 実装
- `items_added` の拡張: ページ送り対応（複数ページの項目を1ターゲットで扱う）、保持期間（現在7日固定）の設定化、一覧に残ったままの項目の状態変化の検知
- 楽天は無料の公式API（Rakuten Web Service。アプリIDのみで利用でき、1秒1リクエストまで）で価格と在庫を取得できる。ブラウザを使わずに済み、規約上も明確なので、楽天ブックス・楽天市場はAPI経由に置き換える価値がある
- `number_at_most` の拡張: 表示テキストではなく属性値（`content=` / `data-price=`）からの読み取り、複数要素の最小値の採用
