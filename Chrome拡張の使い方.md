# ASIN下書きQ・Yahoo入力補助

## 初回登録

1. Chromeで `chrome://extensions/` を開く。
2. 「デベロッパーモード」をオンにする。
3. 「パッケージ化されていない拡張機能を読み込む」を押す。
4. このプロジェクトの `chrome-extension` フォルダを選ぶ。
5. 管理画面とヤフオクのタブを再読み込みする。

登録先：`D:\src\codex\02_Amazon出品・販売・在庫返品連携\26,0607,ASINコピーヤフオク!出品\chrome-extension`

## 使用

このフォルダの `start-extension-tool.cmd` でASINツールを起動し、`http://localhost:41731/` を開く。
商品カードの「下書き文面」から「この商品をヤフオクへ」を押す。
Yahooの出品フォームに進むと、選択した商品の入力補助が開く。
開かなければ右下の「ASIN下書き」を押す。
「まとめて入力」を押し、内容を確認してから下書き保存・出品する。
Yahooから作業を始めた場合は、右下のボタンから商品を選択する。

商品選択はタブ単位で1時間保持。出品確定は手動。
入力項目・画像の実サイト適合はYahoo側のフォーム変更により調整が必要。
在庫連携は今回の対象外。

## 開発・更新

共通の入力補助は `public/yahoo-fill.js` が正本。
変更後に `npm run build:extension` を実行し、Chrome拡張一覧で再読み込みする。
`chrome-extension/yahoo-fill.js` は同梱用コピー。直接編集しない。
Manifest V3のローカル同梱コードを実行し、バックグラウンド経由で41731のAPIに接続する。
localhostの権限はChromeのマッチパターンがポート指定を扱わないためホスト単位だが、処理は41731のみに限定。
画像転送はAmazon画像ホストに限定。その他の画像は既存の手動手順で登録する。
参考：https://developer.chrome.com/docs/extensions/develop/concepts/network-requests

## 今回の確認結果

- 2026-09-16: 管理画面・登録案内を41731で確認。
- 起動中の旧版の41商品を正本へ引き継ぎ。正本の旧18商品と稼働中データは `data/extension-backup-*` へ退避済み。旧フォルダは未変更。
- `node --test tests/extension.test.mjs`: タブ別商品選択、期限切れ、接続先制限、更新内容制限、未起動時の案内を確認。
- `tests/extension-browser.mjs`: テスト用Chrome画面で管理画面からの引き継ぎ、商品選択、商品名・説明・価格・画像入力、出品ボタンが押されないこと、狭い画面での表示を確認。
- ブラウザテストではChrome拡張の通信を模擬。利用中Chromeへの登録と、ログイン後の実際のYahoo出品フォームでの入力確認は別途必要。
- 既存の在庫監視は今回変更していない。切替前の旧版 `/api/stock-watch` は500エラーだったため、旧監視ファイルは移植せず正本側の既存ファイルを保持。
