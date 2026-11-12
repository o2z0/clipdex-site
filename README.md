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
