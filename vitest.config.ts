import { defineConfig } from 'vitest/config';
import dotenv from 'dotenv';
dotenv.config({path:'.env',quiet:true});
export default defineConfig({test:{environment:'node',fileParallelism:false,testTimeout:60000,hookTimeout:60000}});
