import js from "@eslint/js";
import globals from "globals";

export default [
    {
        ignores: ["dist/**", "android/**", ".venv/**"]
    },
    
    // Frontend configuration
    {
        files: ["src/**/*.js", "vite.config.js"],
        languageOptions: {
            globals: {
                ...globals.browser,
                __APP_VERSION__: "readonly",
                IMPORT_AI_MAX_EDGE: "readonly"
            }
        },
        rules: {
            "no-undef": "warn",
            "no-useless-assignment": "warn",
            
            // Allow empty catch blocks { } without throwing a warning
            "no-empty": ["warn", { "allowEmptyCatch": true }],
            
            // Ignore unused variables AND unused caught errors if they start with _
            "no-unused-vars": ["warn", { 
                "argsIgnorePattern": "^_",
                "varsIgnorePattern": "^_",
                "caughtErrorsIgnorePattern": "^_" 
            }]
        }
    },

    // Test files run under Node/Vitest, and they intentionally mix Node-only
    // helpers like Buffer with browser-like globals that are stubbed in tests.
    {
        files: ["src/**/*.test.js"],
        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.node,
                __APP_VERSION__: "readonly",
                IMPORT_AI_MAX_EDGE: "readonly"
            }
        }
    },

    // Backend configuration
    {
        files: ["scripts/**/*.mjs", "cloudflare/**/*.js"],
        languageOptions: {
            globals: {
                ...globals.node
            }
        }
    }
];
