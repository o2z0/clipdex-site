# clipdex-site

macOS アプリ **ClipDex** のプライバシーポリシーとサポートページ。

- https://clipdex.o2z0.com/privacy
- https://clipdex.o2z0.com/support

App Store Connect に登録済みの URL なので、**パスを変えない**こと。
アプリ本体のリポジトリは別 (private)。

## 更新の規則

- 既存 LP (`/`) とフル版 LP (`/full/` `/en/full/`) の**共通節の文言を変えるときは、両方を同じ commit で直す**。画像・動画は `assets/` の 1 系統を両方から参照する (OH-25 sub5 spec §5.1)

## 出どころ

機能の舞台の型は websketch で読み解いたプロダクトビューアから着想、コードと数値は自作。

## 検証

`python3 -m http.server 8765` で配信し、別のターミナルで検査する。

```sh
node --test "tests/unit/*.test.mjs"
node tests/cdp/probe.mjs http://127.0.0.1:8765
bash tools/originality.sh
```

### 検証の記録 (2026-11-12、redesign ブランチ)

- unit 17 pass / originality 0 件 / text-freeze 3 ページ OK (`/` 6 節・facts 17、`/full/` `/en/full/` 6 節・facts 26)
- probe 3 ページ全項目 OK (boot / widths / fit / reduced / idle / reload-mid / nojs / keyboard / rapid / resize / stable / zoom / frames / video / store-facts)
- frames (headless Chrome 1440×900 DPR 2): 壁あり p95 16.7〜16.8ms・25ms 超え 0・long task 0、壁なし p95 16.7〜16.8ms (= rAF の刻みのぶれ幅に収まる)。壁のカード 49 枚・要素 約 500
- check-links 58 URL OK、GA のタグは 21 ページとも main と同じ並び
- 文書ページ 18 枚 × 1280 / 900 / 375 で横あふれ 0 (support / renew の Turnstile エラーはローカル配信のドメインによるもの)

### 機能の舞台の画像を差し替えるとき

寄りの上限は素材の解像度から自動で決まるが、**寄る点 (`data-focus` の x, y) と倍率の上限 (同じく 3 つ目の値)、`<img>` の `width` / `height` は今の画像に合わせた決め打ち**。撮り直して窓の大きさや縦横比が変わったら、3 ページ (`/` `/full/` `/en/full/`) の該当ボタンと画像をまとめて直し、`node tests/cdp/probe.mjs <base> --only zoom` で clamp が起きていないか見る。
