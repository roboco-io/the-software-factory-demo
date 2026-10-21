import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.wrangler/**",
      "**/playwright-report/**",
      "**/test-results/**",
      ".superpowers/**",
      // 평가 케이스 픽스처는 일부러 규칙을 어기는 코드다. eval 체크가 따로 lint한다.
      "factory/evals/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    // React Compiler 규칙(set-state-in-effect 등)은 쓰지 않는다. 고전 규칙 2개만 켠다.
    rules: { "react-hooks/rules-of-hooks": "error", "react-hooks/exhaustive-deps": "error" },
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["scripts/**/*.mjs", "**/*.config.{js,ts}"],
    languageOptions: { globals: globals.node },
  },
  {
    // API 오류는 throw new ApiError(status, { field: [msg] })로만 만든다(공통 핸들러가 응답을 만든다).
    files: ["apps/api/src/routes/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name='json'] > ObjectExpression:first-child > Property[key.name='errors'][value.type='ObjectExpression']",
          message:
            'c.json({ errors: ... })로 오류를 직접 반환하지 말고 throw new ApiError(422, { field: ["message"] })를 사용한다.',
        },
      ],
    },
  },
  {
    files: ["packages/factory/**/*.ts"],
    languageOptions: { globals: globals.node },
  },
);
