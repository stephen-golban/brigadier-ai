//! Minimal stdio MCP server for app-owned session tools. Stdout is protocol-only.
use serde_json::{Value, json};
use std::io::{BufRead, Write};

pub(crate) fn forward(mut request: Value) -> Result<Value, String> {
    if !request.is_object() {
        return Err("Request must be an object".into());
    }
    request["token"] =
        Value::String(std::env::var("BRIGADIER_PEER_TOKEN").map_err(|e| e.to_string())?);
    let endpoint = std::env::var("BRIGADIER_PEER_ENDPOINT").map_err(|e| e.to_string())?;
    let address: std::net::SocketAddr = endpoint
        .parse()
        .map_err(|e: std::net::AddrParseError| e.to_string())?;
    if !address.ip().is_loopback() {
        return Err("Peer endpoint must be local".into());
    }
    let mut socket =
        std::net::TcpStream::connect_timeout(&address, std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
    socket
        .set_read_timeout(Some(std::time::Duration::from_secs(120)))
        .map_err(|e| e.to_string())?;
    writeln!(socket, "{request}").map_err(|e| e.to_string())?;
    let mut response = String::new();
    std::io::BufReader::new(socket)
        .take(2 * 1024 * 1024)
        .read_line(&mut response)
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&response).map_err(|e| e.to_string())
}
use std::io::Read;
fn tools() -> Value {
    let definitions = [
        (
            "list_sessions",
            "List sessions in this project.",
            json!({}),
            vec![],
        ),
        (
            "create_session",
            "Create a visible peer session for a concrete task.",
            json!({"prompt":{"type":"string"},"title":{"type":"string"},"model":{"type":"string"},"isolated":{"type":"boolean","default":false}}),
            vec!["prompt"],
        ),
        (
            "send_message",
            "Send passive information, or queue work without interrupting a busy peer.",
            json!({"sessionId":{"type":"string"},"text":{"type":"string"},"work":{"type":"boolean","default":false}}),
            vec!["sessionId", "text"],
        ),
        (
            "read_inbox",
            "Read peer messages without waking other agents.",
            json!({}),
            vec![],
        ),
        (
            "stop_session",
            "Stop a child session, or request owner confirmation for another session.",
            json!({"sessionId":{"type":"string"}}),
            vec!["sessionId"],
        ),
        (
            "close_session",
            "Stop and close a child session; preserve files and history. Other targets require owner confirmation.",
            json!({"sessionId":{"type":"string"}}),
            vec!["sessionId"],
        ),
    ];
    json!({"tools": definitions.into_iter().map(|(name,description,properties,required)|json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false}})).collect::<Vec<_>>()})
}
fn response(
    request: Value,
    initialized: &mut bool,
    forward: impl FnOnce(Value) -> Result<Value, String>,
) -> Option<Value> {
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    if method == "notifications/initialized" {
        *initialized = true;
        return None;
    }
    let id = request.get("id")?.clone();
    let result = match method {
        "initialize" => Ok(
            json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"brigadier","version":env!("CARGO_PKG_VERSION")}}),
        ),
        "ping" => Ok(json!({})),
        _ if !*initialized => Err((-32002, "Server has not been initialized")),
        "tools/list" => Ok(tools()),
        "tools/call" => {
            let params = &request["params"];
            let action = match params["name"].as_str().unwrap_or("") {
                "list_sessions" => "list",
                "create_session" => "create",
                "send_message" => "message",
                "read_inbox" => "inbox",
                "stop_session" => "stop",
                "close_session" => "close",
                _ => "",
            };
            if action.is_empty() {
                Err((-32602, "Unknown tool"))
            } else {
                let mut args = params.get("arguments").cloned().unwrap_or(json!({}));
                if !args.is_object() {
                    return Some(
                        json!({"jsonrpc":"2.0","id":id,"error":{"code":-32602,"message":"Arguments must be an object"}}),
                    );
                }
                args["action"] = json!(action);
                let (value, error) = match forward(args) {
                    Ok(v) => {
                        let error = v["ok"] != true;
                        (v, error)
                    }
                    Err(e) => (json!({"error":e}), true),
                };
                Ok(json!({"content":[{"type":"text","text":value.to_string()}],"isError":error}))
            }
        }
        _ => Err((-32601, "Method not found")),
    };
    Some(match result {
        Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
        Err((code, message)) => {
            json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}})
        }
    })
}
pub(crate) fn run() {
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let mut output = std::io::stdout().lock();
    let mut initialized = false;
    loop {
        let mut bytes = Vec::new();
        match (&mut input).take(128 * 1024).read_until(b'\n', &mut bytes) {
            Ok(0) | Err(_) => break,
            _ => {}
        }
        if bytes.len() >= 128 * 1024 {
            break;
        }
        let reply = match serde_json::from_slice(&bytes) {
            Ok(request) => response(request, &mut initialized, forward),
            Err(_) => Some(
                json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}),
            ),
        };
        if let Some(reply) = reply {
            if writeln!(output, "{reply}")
                .and_then(|_| output.flush())
                .is_err()
            {
                break;
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn handshake_and_tool_dispatch() {
        let mut ready = false;
        let init = response(
            json!({"id":1,"method":"initialize","params":{"protocolVersion":"2099-01-01"}}),
            &mut ready,
            |_| panic!(),
        )
        .unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2024-11-05");
        assert!(
            response(
                json!({"method":"notifications/initialized"}),
                &mut ready,
                |_| panic!()
            )
            .is_none()
        );
        let listed = response(
            json!({"id":2,"method":"tools/list"}),
            &mut ready,
            |_| panic!(),
        )
        .unwrap();
        assert_eq!(listed["result"]["tools"].as_array().unwrap().len(), 6);
        let call=response(json!({"id":3,"method":"tools/call","params":{"name":"send_message","arguments":{"sessionId":"peer","text":"hello"}}}),&mut ready,|r|{assert_eq!(r["action"],"message");assert_eq!(r["sessionId"],"peer");Ok(json!({"ok":true}))}).unwrap();
        assert_eq!(call["result"]["isError"], false);
        let denied = response(
            json!({"id":4,"method":"tools/call","params":{"name":"close_session"}}),
            &mut ready,
            |_| Err("Permission denied".into()),
        )
        .unwrap();
        assert_eq!(denied["result"]["isError"], true);
    }
}
