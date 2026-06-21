# Examples

End-to-end scenarios that show what excelTemplateParser is for. Each subdirectory contains a self-contained `config.json`, source xlsx files, target template, and the expected output. Walk into one, point the tool at it, and you should get the same output that's committed.

## Available examples

- [**01_product_pricing**](./01_product_pricing) — A 20-SKU product catalog joined against three suppliers' monthly quotes (each with different column naming). Demonstrates **outer join** to surface products that nobody quoted.

More examples will be added — see [the project README](../README.md#examples) for status.
