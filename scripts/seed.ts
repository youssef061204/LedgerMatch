import { createWorkspace, seedWorkspace } from '../src/server/service';
import { pool } from '../src/server/db';
const ctx=await createWorkspace();await seedWorkspace(ctx);console.log(JSON.stringify({workspaceId:ctx.workspaceId,message:'Seeded synthetic workspace for CLI inspection. For a browser session use Try demo, then Load sample data.'}));await pool.end();
