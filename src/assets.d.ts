/** Markdown files imported with `with { type: "text" }` (embedded in compiled binaries). */
declare module "*.md" {
	const text: string;
	export default text;
}
