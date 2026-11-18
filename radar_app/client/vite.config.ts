import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    build: {
        emptyOutDir: true,
        rolldownOptions: {
            output: {
                codeSplitting: {
                    groups: [
                        {
                            name: 'kendo-vendor',
                            test: /node_modules[\\/]@progress/, // KendoReact - отдельно
                            priority: 20
                        },
                        {
                            name: 'vendor',
                            test: /node_modules/,
                            priority: 10
                        }
                    ]
                }
            }
        },
        chunkSizeWarningLimit: 2500
    }
});
