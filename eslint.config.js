import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.wrangler/**",
      "experiments/**",
      "**/worker-configuration.d.ts",
    ],
  },
  ...tseslint.configs.recommended,
);
