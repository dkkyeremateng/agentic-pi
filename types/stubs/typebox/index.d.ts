export declare const Type: {
    Object: (props: any, options?: any) => any;
    String: (options?: any) => any;
    Number: (options?: any) => any;
    Boolean: (options?: any) => any;
    Array: (schema: any, options?: any) => any;
    Optional: (schema: any) => any;
    Union: (schemas: any[], options?: any) => any;
    Literal: (val: any) => any;
    [key: string]: any;
};
