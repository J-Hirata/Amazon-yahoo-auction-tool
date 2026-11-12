# 写真ナビのリサーチとの接続（2026-11-13 MVP）

機能と操作の正本は写真仕分けナビのdocs/research-mvp-20261113.md。本リポジトリは既存Amazon接続・Keepaの読取りと、既存の写真下書きへの受領を担当する。在庫・通知・価格変更・実出品の処理には接続しない。

## サーバー設定

既存のASIN_AMAZON_*を再利用。KeepaはRESEARCH_KEEPA_API_KEY（Productionのみ・sensitive）または既存KEEPA_API_KEY。写真共有のPHOTO_BRIDGE_KEYとPHOTO_BRIDGE_WORKSPACE_IDで相手を限定する。秘密の値をphoto-packageへ含めたりブラウザーへ出したりしない。

- GET /api/research/capabilities：HMAC署名が必要。設定の有無だけを返す。
- POST /api/research/query：research-query/v1、workspace ID、product ID、operation ID、検索入力・比較設定・0/1のKeepa要求枠。署名した写真ナビからだけ受ける。短時間の同一操作再送をキャッシュし、同じIDの内容変更を拒否。
- POST /api/research/context：research-context/v1。先に受け取った写真セットのworkspace/product/package ID・digestと一致した場合だけ受領する。
- 既存の本人認証、同一Origin確認、readOnly設定、写真の非公開取得・ハッシュ検証は保持する。

価格APIのレートヘッダー・Retry-Afterに合わせて待機し、429は全体26秒の取得期限内で各状態最大2回再試行する。次のジョブにも待機間隔を渡す。失敗した価格を0円で埋めず、追加Keepa要求の再実行はしない。

Amazonは日本のCatalog Items/Item Offersを読み、一般購入者の新品/中古を分ける。Summaryに複数状態があっても要求状態で絞る。中古価格の代わりに新品価格やプライマリ価格を使わない。出品可否をカタログ存在から推定しない。Keepaは保存済みのNEW/USEDだけを参考表示し、送料は未確認・成約価格とは扱わない。

## 既存下書き

photo-libraryのversionは1のまま、任意のresearchContextsを追加する。古い保存データには必須にしない。下書きにresearchContextIdがあれば同じ写真セットに含まれることを検査する。研究結果を理由にSKU/ASIN単独で別個体へ関連付けしない。

共有画面の#research=IDで対応する写真下書きを開く。新規時は本人の現物状態・付属品と本人が指定した価格を初期入力する。既存の説明・価格は保持し、「確認済みリサーチ内容を説明・価格に読み込む」を押した場合だけ編集欄へ読み込む。保存しても外部のヤフオクには出品されない。

## 検証

tests/research-*.test.mjsと、写真側scripts/cloud/verify-research-mvp.ts（独立QA DB・合成画像）で確認する。本番の環境変数一式をローカルへ複製しない。公開確認には既存の認証済みCLI、署名付き読取り、Neon接続の読取り専用照合を必要な範囲だけ使う。
