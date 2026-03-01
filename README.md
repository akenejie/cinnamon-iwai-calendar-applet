# 日付を見たときに、今日が祝日かどうか分かる！

LinuxのCinnamonデスクトップ環境で使用可能な、「今日が祝日かどうか」が簡単に認識できるアプレットで、特に日本に特化させたものです。

このアプレットは[Calendar with public Holidays](https://cinnamon-spices.linuxmint.com/applets/view/329)のフォークです。

変更点としては、まず日本の祝日の情報ソースは内閣府のWebサイトとしています。
それから、日付の書式としてPython標準書式以外に、`%ｼ`=祝日名、`%ﾕ`=「・」+祝日名、`%ｲ`=「祝」、`%ﾜ`=「・祝」（祝日でなければ空文字）が利用できます。

例:
- `%Y/%m/%d (%a%ｲ) %H:%M:%S` → `2026/01/01 (木祝) 12:34:56`、`2026/01/02 (金) 12:34:56`
- `%Y年%-m月%-e日 (%a%ﾕ)` → `2026年1月1日 (木・元旦)`、`2026年1月2日 (金)`

## 使い方

1. `README.md`のあるディレクトリが`~/.local/share/cinnamon/applets/calendar@akenejie`になるようにファイルをコピーする
2. po/ ディレクトリ内で `msgfmt ja.po -o ~/.local/share/locale/ja/LC_MESSAGES/calendar@akenejie.mo` を実行し、UIの日本語訳をコンパイルする
（アケネＪが確認している動作環境: Linux Mint 22.3 Cinnamon 6.6.7）
