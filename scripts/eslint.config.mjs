import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
export default tseslint.config(
    {ignores:['node_modules/**','venv/**','scripts/vendor/**','main.js']},
    {files:['**/*.js','**/*.cjs','**/*.mjs','**/*.ts'],languageOptions:{globals:{...globals.browser,...globals.node}}},
    js.configs.recommended,
    ...tseslint.configs.recommended.map(config=>({...config,files:['**/*.ts']})),
);
