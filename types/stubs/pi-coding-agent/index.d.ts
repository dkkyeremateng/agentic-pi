export interface ExtensionContext {
    cwd: string;
    ui?: any;
    sessionManager?: any;
    [key: string]: any;
}

export type ExtensionCommandContext = ExtensionContext;

export interface AgentToolResult<T = any> {
    content: Array<{ type: string; text?: string; [key: string]: any }>;
    details?: T;
    [key: string]: any;
}

export interface ToolDefinition<T = any> {
    name: string;
    description: string;
    parameters?: T;
    execute: (args: any, ctx: ExtensionContext) => Promise<AgentToolResult> | AgentToolResult;
}

export interface ExtensionAPI {
    registerTool: (tool: ToolDefinition | any) => void;
    registerCommand: (name: string, def: any) => void;
    on: (event: string, handler: (...args: any[]) => any) => void;
    [key: string]: any;
}

export declare function isToolCallEventType(...args: any[]): boolean;
export declare function getMarkdownTheme(...args: any[]): any;
