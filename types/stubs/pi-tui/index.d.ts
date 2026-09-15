export declare class Text {
    constructor(...args: any[]);
    render(...args: any[]): any;
    [key: string]: any;
}

export declare class Markdown {
    constructor(...args: any[]);
    render(...args: any[]): any;
    [key: string]: any;
}

export declare class Container {
    constructor(...args: any[]);
    addChild(child: any): any;
    render(...args: any[]): any;
    [key: string]: any;
}

export declare function visibleWidth(str: string): number;
export declare function truncateToWidth(str: string, width: number, ellipsis?: string): string;
