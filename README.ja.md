# showa-emu

**昭和の居間ごと動く、ファミコンエミュレータ。**

▶ **遊ぶ:** https://kurogedelic.github.io/showa-emu/  
English: [README.md](README.md)

`showa-emu` は、ファミコン本体だけでなく、ブラウン管テレビ、RF接続、カセット端子、ケーブル、家具、部屋の物理現象まで含めて「ファミコンを遊んでいた状況そのもの」をエミュレートしようとする実験的なWebエミュレータです。

[GOROman/cluade-famicom-emu](https://github.com/GOROman/cluade-famicom-emu) をベースにしています。

起動時には [kurogedelic](https://github.com/kurogedelic) 制作のオリジナルROM `nobunaga.nes` が読み込まれます。ブラウザから手持ちの `.nes` ROMを読み込むこともできます。

## コンセプト

普通のエミュレータは「機械」を再現します。**showa-emu は、その機械が置かれていた環境まで再現します。**

8畳の畳部屋にブラウン管テレビ、ファミコン、RFスイッチボックスが置かれています。接続は物理的に外れ、カセットは接触不良を起こし、家具には質量があり、映像はクリーンなフレームバッファではなくアナログTV信号として振る舞います。

## 再現しているもの

- **NTSC / RF映像** — カラーサブキャリアへの変調・復調、クロマ帯域制限、コムフィルタ、ドットクロール、色滲み、ゴースト、カラ―キラー、スノーノイズ、同期崩れ。
- **CRT表示** — ゲーム画面だけでなく診断OSDもCRT/RF処理を通ります。
- **物理ケーブル** — RF、テレビ電源、ファミコンACアダプタを有限長のVerlet ropeとして再現。引っ張り切るとプラグが抜けます。
- **カセット端子** — 109.5 × 70 × 17 mmのシェル、90 × 46.1 mm基板、2.54 mmピッチ60接点をモデル化。カセットを持ち上げたり傾けたりすると接点が順番に切れます。
- **部屋の物理演算** — `cannon-es` を使用。テレビ、テレビ台、ファミコンなどを掴んだり投げたりでき、衝撃で映像やカセット接点にも影響が出ます。
- **光線銃** — コア側で `$4017` のトリガー／光検出を実装し、照準位置のフレームバッファをブラウザ側で判定します。対応ゲームでは実際にZapperとして機能します。
- **余計な現実** — 壁が倒れる、ゴキブリが出る、殺虫剤を撒ける、雨漏りする、オレンジジュースをこぼせる、ジュースがファミコンまで届くと端子が不調になる、Zapperから連続光線が出て物体を押したり煙を出したりします。
- **酒** — 飲むと一時的に視野が歪み、十字キーが逆になります。

部屋の3Dオブジェクトは標準ではすべてコード生成です。glTF/GLBモデルへの差し替えにも対応しています。詳しくは [`web/assets/models/README.md`](web/assets/models/README.md) を参照してください。

## 操作

**テレビ**にカーソルを合わせると、チューニング、UHFゲイン、CRT、OSD、音量などを操作できます。  
**ファミコン本体**では電源、リセット、ROM操作ができます。`.nes` ファイルのドロップにも対応しています。  
**カセット**では傾きと接点状態を確認できます。

左下のオーバーレイから、電源、リセット、掴むモード、片付け、室内灯、各種小道具を操作できます。何もない場所をドラッグするとカメラ回転、中ボタンドラッグでパンします。

| NES | キーボード | ゲームパッド |
|---|---|---|
| 十字キー | 矢印キー | D-pad / 左スティック |
| A / B | X / Z | 右 / 下ボタン |
| Start / Select | Enter / Shift | Start / Select |

ホットキー: **F** 全画面 · **R** リセット（長押し） · **D** デバッグパネル

主なURLパラメータ:

- `?room=0` — 元の2Dエミュレータ表示
- `rom=` — ROM指定
- `debug=1` — デバッグUI
- `pin=0`, `clock=`, `tilt=`, `break=` — 故障／デバッグ系
- `mute=1`, `vol=` — 音声
- `lang=` — 言語

## 構成

```text
core/                 C++ ファミコンエミュレータコア
  └─ nes.cpp / nes.h  CPU / PPU / APU統合 + Zapper対応

web/
  ├─ main.js           エミュレータとブラウザの接続
  ├─ room.js           昭和部屋、描画、操作、物理演算
  ├─ props.js          小道具・各種イベント
  ├─ cables.js         ケーブル物理
  ├─ sfx.js            室内効果音
  ├─ layout.js         レイアウト補助
  ├─ audio-worklet.js  APU音声再生
  ├─ nes.js / nes.wasm Emscripten生成物
  └─ vendor/           three.js + cannon-es
```

エミュレータコアはC++からEmscriptenでWebAssemblyにコンパイルします。3D部分はプレーンなES Modules + `three.js` + `cannon-es` で、専用のバンドル工程はありません。

## ビルド

```sh
./build.sh
cd web
python3 -m http.server 8765
```

その後 `http://localhost:8765/` を開きます。

## Credits

元になった **6502 / PPU / APUエミュレータコア、60ピン故障モデル、オシロスコープ、デバッガ** は [GOROman](https://github.com/GOROman) 氏の実装です。原作と詳細なドキュメントは [GOROman/cluade-famicom-emu](https://github.com/GOROman/cluade-famicom-emu) を参照してください。

このforkでは、そのエミュレータの外側に昭和の部屋と物理環境を追加しています。

同梱ライブラリ:

- [three.js](https://threejs.org/) r180 — MIT
- [cannon-es](https://github.com/pmndrs/cannon-es) 0.20 — MIT

`web/assets/roms/nobunaga.nes` は © kurogedelic。その他は特記がない限りMIT Licenseです。