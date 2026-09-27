/**
 * Jevonian Multi-Agent Verification Script
 * Probes both OpenCode (8787) and Claude Code (8790) gateways.
 * Tests model discovery and tests the OpenCode Anthropic-block wire normalizer.
 */

async function checkGateway(name, url, testFn) {
  process.stdout.write(`Checking ${name} (${url})... `);
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`FAIL (HTTP ${res.status})`);
      return false;
    }
    const data = await res.json();
    console.log(`OK (HTTP ${res.status})`);
    if (testFn) {
      await testFn(data);
    }
    return true;
  } catch (err) {
    console.log(`OFFLINE (${err.message})`);
    return false;
  }
}

async function testOpenCodeNormalizer() {
  process.stdout.write(`Testing OpenCode wire normalizer on :8787 (tool_use / tool_result blocks)... `);
  try {
    const res = await fetch("http://127.0.0.1:8787/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer local-no-key",
      },
      body: JSON.stringify({
        model: "auto",
        stream: false,
        messages: [
          { role: "user", content: "Check the status of the app." },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Let me check the config:" },
              {
                type: "tool_use",
                id: "call_test123",
                name: "test_tool",
                input: { path: "package.json" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call_test123",
                content: '{"status": "ok"}',
              },
            ],
          },
          { role: "user", content: "Now summarize what you found." },
        ],
      }),
    });

    if (res.ok) {
      const data = await res.json();
      console.log(`SUCCESS! Routed to: ${data.model}`);
      return true;
    } else {
      const err = await res.text();
      console.log(`FAIL: HTTP ${res.status} - ${err.slice(0, 150)}`);
      return false;
    }
  } catch (err) {
    console.log(`ERROR: ${err.message}`);
    return false;
  }
}

async function run() {
  console.log("=================================================");
  console.log("   Jevonian Multi-Agent Gateway Verification     ");
  console.log("=================================================\n");

  const opencodeUp = await checkGateway(
    "OpenCode Gateway (Port 8787)",
    "http://127.0.0.1:8787/v1/models",
    (data) => {
      const models = (data.data || []).map((m) => m.id);
      console.log(`  Models available: ${models.join(", ")}`);
    }
  );

  console.log();

  const claudeUp = await checkGateway(
    "Claude Code Gateway (Port 8790)",
    "http://127.0.0.1:8790/v1/models",
    (data) => {
      const models = (data.data || []).map((m) => m.id);
      console.log(`  Models available: ${models.join(", ")}`);
    }
  );

  console.log();

  if (opencodeUp) {
    await testOpenCodeNormalizer();
  }

  console.log("\n=================================================");
  console.log("   Dashboards:");
  console.log("   OpenCode:    http://127.0.0.1:8787/logs");
  console.log("   Claude Code: http://127.0.0.1:8790/logs");
  console.log("=================================================");
}

run();
