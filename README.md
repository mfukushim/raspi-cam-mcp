# Raspberry Pi camera MCP server

> Note:  
> This program is entirely AI-generated and has not been thoroughly tested.  
> It is intended for experimental use within a LAN. As it does not use HTTPS, there is no security whatsoever; do not use it over the internet.  
> The camera images are intended to be processed by an LLM. Please be aware of privacy implications, as images will be sent to the AI provider if you use external LLM APIs.  

> 注意:  
> フルAI生成のプログラムです。あまりきちんと検証していません。  
> LAN内での実験用利用を想定しています。httpですので暗号化はなく、セキュリティは皆無です。インターネット上で使用してはいけません。  
> カメラ画像はLLMに読まれることを想定しています。外部LLM APIなどを利用する場合、画像はAI提供元に送信されますのでプライバシーにご注意ください。  

Raspberry Pi の CSI カメラから JPEG を１枚撮り、MCP の `capture_image` ツールで画像として返す小さな TypeScript サーバーです。Streamable HTTP のエンドポイントは `/mcp` で、共有トークンを使います。

## 準備

- Raspberry Pi OS で `rpicam-still` が使えることを確認してください。先に `rpicam-hello --list-cameras` と `rpicam-still -n -t 1000 -o test.jpg` を実行すると切り分けが簡単です。
- Node.js 22 以上と pnpm を用意します。( https://nodesource.com/products/distributions などで Ubuntu の node 22以降を設定してください。)

```bash
pnpm install --frozen-lockfile
pnpm build
```

## 起動

`MCP_HOST` は Pi の LAN 側 IPv4 アドレスに設定してください。起動時にそのアドレスへバインドし、異なる `Host` ヘッダーを拒否します。IP が変わったら設定も更新します。`MCP_TOKEN` は必須です。

```bash
export MCP_HOST=192.168.1.50
export MCP_PORT=3000
export MCP_TOKEN="$(openssl rand -hex 32)"
pnpm start
```

接続先は `http://192.168.1.50:3000/mcp`、認証ヘッダーは `Authorization: Bearer <MCP_TOKEN>` です。クライアントの設定に URL と固定の Bearer トークンを指定してください。`MCP_HOST` を省略すると `127.0.0.1` にのみバインドします。`MCP_PORT` の既定値は `3000` です。

### wlan0 の IP で起動

Pi 上で `MCP_TOKEN` を設定した後、次のワンライナーで現在の `wlan0` の IPv4 アドレスへバインドできます。

```bash
MCP_HOST="$(ip -4 -o address show dev wlan0 scope global | awk 'NR == 1 { split($4, a, "/"); print a[1] }')" node dist/server.js
```

同じ処理を行う [起動スクリプト](scripts/start-wlan0.sh) も用意しています。こちらは IP が未設定ならエラーで終了するため、systemd からの起動に使えます。

```bash
MCP_TOKEN="YOUR_SAVED_TOKEN" bash scripts/start-wlan0.sh
```

### systemd で自動起動

[サービス定義の例](deploy/raspi-cam-mcp.service.example) を Pi 上でコピーし、`YOUR_USER` とプロジェクトの配置先を実際の値に変更します。Node.js を `/usr/bin/node` 以外に入れた場合は、環境ファイルに `NODE_BIN=/実際の/node/へのパス` を追加します。

```bash
sudo install -m 644 deploy/raspi-cam-mcp.service.example /etc/systemd/system/raspi-cam-mcp.service
sudoedit /etc/systemd/system/raspi-cam-mcp.service
```

トークンはサービス定義に直接書かず、Pi 上の環境ファイルへ保存します。次のコマンドはトークンを新規生成して表示します。既にクライアントに設定したトークンがある場合は、その値をファイルに設定してください。

```bash
sudo install -m 600 -o root -g root /dev/null /etc/raspi-cam-mcp.env
TOKEN="$(openssl rand -hex 32)"
printf 'MCP_TOKEN=%s\nMCP_PORT=3000\n' "$TOKEN" | sudo tee /etc/raspi-cam-mcp.env >/dev/null
printf 'クライアントに設定するトークン: %s\n' "$TOKEN"
sudo systemctl daemon-reload
sudo systemctl enable --now raspi-cam-mcp.service
sudo systemctl status raspi-cam-mcp.service
```

接続先の確認は `ip -4 -o address show dev wlan0 scope global`、ログの確認は `journalctl -u raspi-cam-mcp.service -f` です。Wi-Fi がまだ接続されていない場合はサービスが５秒後に再試行します。実行中に DHCP で IP が変わった場合は `sudo systemctl restart raspi-cam-mcp.service` を実行してください。

接続確認の例です。Pi または同じ LAN の端末から実行できます。

```bash
curl -i http://192.168.1.50:3000/mcp \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl-test","version":"1.0.0"}}}'
```

初期化応答にサーバー名が表示されれば接続できています。実際の画像確認には MCP クライアントから `capture_image` を呼んでください。

撮影時は `rpicam-still --nopreview --timeout 1000 --width 1280 --height 720 --quality 85 --output -` を実行します。画像は保存せず、JPEG の Base64 を MCP ImageContent で返します。撮影が重なった場合は後から来た呼び出しにエラーを返します。`RPICAM_STILL` でコマンドのパスを変更できます。

## LAN で使う際の注意

HTTP ではトークンと画像が暗号化されません。信頼できる LAN 内だけで使用し、ルーターでインターネットへポート公開しないでください。トークンは環境変数などに保存し、Git に入れないでください。ブラウザーからの `Origin` 付きリクエストは拒否します。
