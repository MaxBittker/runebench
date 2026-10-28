import asyncio
import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "agents"))
from codex_subscription_adapter import CodexSubscription, _subscription_auth_path
from codex_adapter import CodexWithTimeout
from harbor.agents.installed.codex import Codex


class SubscriptionAuthTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = pathlib.Path(self.tmp.name) / "auth.json"
        self.env = {"CODEX_AUTH_JSON_PATH": str(self.path)}

    def tearDown(self):
        self.tmp.cleanup()

    def auth(self, data):
        self.path.write_text(json.dumps(data))

    def valid(self):
        self.auth(
            {"auth_mode": "chatgpt", "tokens": {"access_token": "synthetic-test-token"}}
        )

    def test_accepts_chatgpt(self):
        self.valid()
        self.assertEqual(_subscription_auth_path(self.env.get), self.path)

    def test_missing_auth_cannot_fall_back_to_api_key(self):
        self.env["OPENAI_API_KEY"] = "synthetic-api-key"
        with self.assertRaisesRegex(ValueError, "required"):
            _subscription_auth_path(self.env.get)

    def test_api_auth_rejected(self):
        self.auth({"OPENAI_API_KEY": "synthetic-api-key"})
        with self.assertRaisesRegex(ValueError, "forbidden"):
            _subscription_auth_path(self.env.get)

    def test_empty_oauth_rejected(self):
        self.auth({"auth_mode": "chatgpt", "tokens": {"access_token": ""}})
        with self.assertRaisesRegex(ValueError, "no API fallback"):
            _subscription_auth_path(self.env.get)

    def test_forced_api_rejected(self):
        self.valid()
        self.env["CODEX_FORCE_API_KEY"] = "1"
        with self.assertRaisesRegex(ValueError, "forbidden"):
            _subscription_auth_path(self.env.get)

    def test_base64_rejected(self):
        self.valid()
        self.env["CODEX_AUTH_JSON_B64"] = "synthetic"
        with self.assertRaisesRegex(ValueError, "base64"):
            _subscription_auth_path(self.env.get)

    def test_custom_endpoint_rejected(self):
        agent = object.__new__(CodexSubscription)
        with self.assertRaisesRegex(ValueError, "endpoints"):
            agent._build_effective_config("https://example.com")

    def test_effective_config_enforces_chatgpt(self):
        agent = object.__new__(CodexSubscription)
        with patch.object(Codex, "_build_effective_config", return_value={}):
            self.assertEqual(
                agent._build_effective_config(None),
                {"forced_login_method": "chatgpt", "model_provider": "openai"},
            )

    def test_accepts_legacy_oauth_without_mode(self):
        self.auth({"tokens": {"access_token": "synthetic-token"}})
        self.assertEqual(_subscription_auth_path(self.env.get), self.path)

    def test_malformed_json_rejected(self):
        self.path.write_text("{")
        with self.assertRaisesRegex(ValueError, "valid ChatGPT"):
            _subscription_auth_path(self.env.get)

    def test_custom_provider_config_rejected(self):
        agent = object.__new__(CodexSubscription)
        with patch.object(
            Codex,
            "_build_effective_config",
            return_value={"model_providers": {"custom": {}}},
        ):
            with self.assertRaisesRegex(ValueError, "provider configuration"):
                agent._build_effective_config(None)

    def test_run_rejects_missing_auth_before_parent_execution(self):
        agent = object.__new__(CodexSubscription)
        agent._get_env = self.env.get

        async def check():
            with patch.object(Codex, "run", new_callable=AsyncMock) as parent:
                with self.assertRaisesRegex(ValueError, "required"):
                    await agent.run("test", None, None)
                parent.assert_not_awaited()

        asyncio.run(check())

    def test_run_bypasses_legacy_api_routing(self):
        self.valid()
        agent = object.__new__(CodexSubscription)
        agent._get_env = self.env.get
        agent.exec_as_agent = AsyncMock()

        async def check():
            with (
                patch.object(Codex, "run", new_callable=AsyncMock) as parent,
                patch.object(CodexWithTimeout, "run", new_callable=AsyncMock) as legacy,
            ):
                await agent.run("test", None, None)
                parent.assert_awaited_once_with(agent, "test", None, None)
                legacy.assert_not_awaited()

        asyncio.run(check())

    def test_command_forces_chatgpt_and_clears_api_keys(self):
        self.valid()
        agent = object.__new__(CodexSubscription)
        agent._get_env = self.env.get
        agent._run_timeout_sec = None
        agent._service_tier = None
        agent._fast_mode = False

        async def check():
            with patch.object(Codex, "exec_as_agent", new_callable=AsyncMock) as parent:
                await agent.exec_as_agent(
                    None,
                    "codex exec --json",
                    env={"OPENAI_API_KEY": "synthetic", "CODEX_API_KEY": "synthetic"},
                )
                call = parent.call_args
                self.assertIn('forced_login_method="chatgpt"', call.args[1])
                self.assertEqual(call.kwargs["env"]["OPENAI_API_KEY"], "")
                self.assertEqual(call.kwargs["env"]["CODEX_API_KEY"], "")

        asyncio.run(check())


if __name__ == "__main__":
    unittest.main()
