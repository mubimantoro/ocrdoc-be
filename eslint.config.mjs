import globals from "globals";
import daStyle from 'eslint-config-dicodingacademy';
import pluginJs from '@eslint/js';
import { defineConfig } from "eslint/config";

export default defineConfig([
  daStyle,
    { files: ['**/*.js'], languageOptions: { sourceType: 'module' } },
  { languageOptions: { globals: globals.node } },
  pluginJs.configs.recommended,
]);
