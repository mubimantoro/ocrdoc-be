import globals from "globals";
import daStyle from 'eslint-config-dicodingacademy';
import pluginJs from '@eslint/js';
import { defineConfig } from "eslint/config";

export default defineConfig([
  daStyle,
    { 
      files: ['**/*.js'], 
      languageOptions: { sourceType: 'module' },
      rules: {
        'linebreak-style': 'off'
      }
    },
  { languageOptions: { globals: globals.node } },
  pluginJs.configs.recommended,
]);
