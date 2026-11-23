# Loyalty discount function (TypeScript)

## Dependencies

- Use the Node.js version required by the app and install Shopify CLI.
- Run `npm install` from the app root to install the extension's workspace dependencies.
- Rust and Cargo are not required.

## Building the function

From the app root:

```shell
npm run build --workspace loyalty-discount
npm test --workspace loyalty-discount
```

Shopify CLI generates TypeScript types from the input query and schema, then compiles
`src/index.ts` to `dist/function.wasm`. Run `npm run typegen --workspace loyalty-discount`
after editing the query if you only need to refresh the types.

Run `shopify app dev` from the app root to preview the full app with this extension.

The function applies a 100% product discount to one unit of the first cart line
matching the variant ID stored in `loyalty_discount.configuration`. It returns no
discount when the configuration or matching variant is missing, or when the
discount does not support the PRODUCT class.
