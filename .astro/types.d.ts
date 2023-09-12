declare module 'astro:content' {
	interface Render {
		'.mdx': Promise<{
			Content: import('astro').MarkdownInstance<{}>['Content'];
			headings: import('astro').MarkdownHeading[];
			remarkPluginFrontmatter: Record<string, any>;
		}>;
	}
}

declare module 'astro:content' {
	interface Render {
		'.md': Promise<{
			Content: import('astro').MarkdownInstance<{}>['Content'];
			headings: import('astro').MarkdownHeading[];
			remarkPluginFrontmatter: Record<string, any>;
		}>;
	}
}

declare module 'astro:content' {
	export { z } from 'astro/zod';
	export type CollectionEntry<C extends keyof AnyEntryMap> = AnyEntryMap[C][keyof AnyEntryMap[C]];

	// TODO: Remove this when having this fallback is no longer relevant. 2.3? 3.0? - erika, 2023-04-04
	/**
	 * @deprecated
	 * `astro:content` no longer provide `image()`.
	 *
	 * Please use it through `schema`, like such:
	 * ```ts
	 * import { defineCollection, z } from "astro:content";
	 *
	 * defineCollection({
	 *   schema: ({ image }) =>
	 *     z.object({
	 *       image: image(),
	 *     }),
	 * });
	 * ```
	 */
	export const image: never;

	// This needs to be in sync with ImageMetadata
	export type ImageFunction = () => import('astro/zod').ZodObject<{
		src: import('astro/zod').ZodString;
		width: import('astro/zod').ZodNumber;
		height: import('astro/zod').ZodNumber;
		format: import('astro/zod').ZodUnion<
			[
				import('astro/zod').ZodLiteral<'png'>,
				import('astro/zod').ZodLiteral<'jpg'>,
				import('astro/zod').ZodLiteral<'jpeg'>,
				import('astro/zod').ZodLiteral<'tiff'>,
				import('astro/zod').ZodLiteral<'webp'>,
				import('astro/zod').ZodLiteral<'gif'>,
				import('astro/zod').ZodLiteral<'svg'>
			]
		>;
	}>;

	type BaseSchemaWithoutEffects =
		| import('astro/zod').AnyZodObject
		| import('astro/zod').ZodUnion<import('astro/zod').AnyZodObject[]>
		| import('astro/zod').ZodDiscriminatedUnion<string, import('astro/zod').AnyZodObject[]>
		| import('astro/zod').ZodIntersection<
				import('astro/zod').AnyZodObject,
				import('astro/zod').AnyZodObject
		  >;

	type BaseSchema =
		| BaseSchemaWithoutEffects
		| import('astro/zod').ZodEffects<BaseSchemaWithoutEffects>;

	export type SchemaContext = { image: ImageFunction };

	type DataCollectionConfig<S extends BaseSchema> = {
		type: 'data';
		schema?: S | ((context: SchemaContext) => S);
	};

	type ContentCollectionConfig<S extends BaseSchema> = {
		type?: 'content';
		schema?: S | ((context: SchemaContext) => S);
	};

	type CollectionConfig<S> = ContentCollectionConfig<S> | DataCollectionConfig<S>;

	export function defineCollection<S extends BaseSchema>(
		input: CollectionConfig<S>
	): CollectionConfig<S>;

	type AllValuesOf<T> = T extends any ? T[keyof T] : never;
	type ValidContentEntrySlug<C extends keyof ContentEntryMap> = AllValuesOf<
		ContentEntryMap[C]
	>['slug'];

	export function getEntryBySlug<
		C extends keyof ContentEntryMap,
		E extends ValidContentEntrySlug<C> | (string & {})
	>(
		collection: C,
		// Note that this has to accept a regular string too, for SSR
		entrySlug: E
	): E extends ValidContentEntrySlug<C>
		? Promise<CollectionEntry<C>>
		: Promise<CollectionEntry<C> | undefined>;

	export function getDataEntryById<C extends keyof DataEntryMap, E extends keyof DataEntryMap[C]>(
		collection: C,
		entryId: E
	): Promise<CollectionEntry<C>>;

	export function getCollection<C extends keyof AnyEntryMap, E extends CollectionEntry<C>>(
		collection: C,
		filter?: (entry: CollectionEntry<C>) => entry is E
	): Promise<E[]>;
	export function getCollection<C extends keyof AnyEntryMap>(
		collection: C,
		filter?: (entry: CollectionEntry<C>) => unknown
	): Promise<CollectionEntry<C>[]>;

	export function getEntry<
		C extends keyof ContentEntryMap,
		E extends ValidContentEntrySlug<C> | (string & {})
	>(entry: {
		collection: C;
		slug: E;
	}): E extends ValidContentEntrySlug<C>
		? Promise<CollectionEntry<C>>
		: Promise<CollectionEntry<C> | undefined>;
	export function getEntry<
		C extends keyof DataEntryMap,
		E extends keyof DataEntryMap[C] | (string & {})
	>(entry: {
		collection: C;
		id: E;
	}): E extends keyof DataEntryMap[C]
		? Promise<DataEntryMap[C][E]>
		: Promise<CollectionEntry<C> | undefined>;
	export function getEntry<
		C extends keyof ContentEntryMap,
		E extends ValidContentEntrySlug<C> | (string & {})
	>(
		collection: C,
		slug: E
	): E extends ValidContentEntrySlug<C>
		? Promise<CollectionEntry<C>>
		: Promise<CollectionEntry<C> | undefined>;
	export function getEntry<
		C extends keyof DataEntryMap,
		E extends keyof DataEntryMap[C] | (string & {})
	>(
		collection: C,
		id: E
	): E extends keyof DataEntryMap[C]
		? Promise<DataEntryMap[C][E]>
		: Promise<CollectionEntry<C> | undefined>;

	/** Resolve an array of entry references from the same collection */
	export function getEntries<C extends keyof ContentEntryMap>(
		entries: {
			collection: C;
			slug: ValidContentEntrySlug<C>;
		}[]
	): Promise<CollectionEntry<C>[]>;
	export function getEntries<C extends keyof DataEntryMap>(
		entries: {
			collection: C;
			id: keyof DataEntryMap[C];
		}[]
	): Promise<CollectionEntry<C>[]>;

	export function reference<C extends keyof AnyEntryMap>(
		collection: C
	): import('astro/zod').ZodEffects<
		import('astro/zod').ZodString,
		C extends keyof ContentEntryMap
			? {
					collection: C;
					slug: ValidContentEntrySlug<C>;
			  }
			: {
					collection: C;
					id: keyof DataEntryMap[C];
			  }
	>;
	// Allow generic `string` to avoid excessive type errors in the config
	// if `dev` is not running to update as you edit.
	// Invalid collection names will be caught at build time.
	export function reference<C extends string>(
		collection: C
	): import('astro/zod').ZodEffects<import('astro/zod').ZodString, never>;

	type ReturnTypeOrOriginal<T> = T extends (...args: any[]) => infer R ? R : T;
	type InferEntrySchema<C extends keyof AnyEntryMap> = import('astro/zod').infer<
		ReturnTypeOrOriginal<Required<ContentConfig['collections'][C]>['schema']>
	>;

	type ContentEntryMap = {
		"docs": {
"404.md": {
	id: "404.md";
  slug: "404";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Azure/AI-102.md": {
	id: "Azure/AI-102.md";
  slug: "azure/ai-102";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Azure/AI-900.md": {
	id: "Azure/AI-900.md";
  slug: "azure/ai-900";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Azure/AZ-104.md": {
	id: "Azure/AZ-104.md";
  slug: "azure/az-104";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Azure/AZ-120.md": {
	id: "Azure/AZ-120.md";
  slug: "azure/az-120";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Azure/AZ-140.md": {
	id: "Azure/AZ-140.md";
  slug: "azure/az-140";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Azure/AZ-204.md": {
	id: "Azure/AZ-204.md";
  slug: "azure/az-204";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Azure/AZ-305.md": {
	id: "Azure/AZ-305.md";
  slug: "azure/az-305";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Azure/AZ-400.md": {
	id: "Azure/AZ-400.md";
  slug: "azure/az-400";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Azure/AZ-500.md": {
	id: "Azure/AZ-500.md";
  slug: "azure/az-500";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Azure/AZ-700.md": {
	id: "Azure/AZ-700.md";
  slug: "azure/az-700";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Azure/AZ-800.md": {
	id: "Azure/AZ-800.md";
  slug: "azure/az-800";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Azure/AZ-801.md": {
	id: "Azure/AZ-801.md";
  slug: "azure/az-801";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Azure/AZ-900.md": {
	id: "Azure/AZ-900.md";
  slug: "azure/az-900";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Azure/DP-100.md": {
	id: "Azure/DP-100.md";
  slug: "azure/dp-100";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Azure/DP-203.md": {
	id: "Azure/DP-203.md";
  slug: "azure/dp-203";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Azure/DP-300.md": {
	id: "Azure/DP-300.md";
  slug: "azure/dp-300";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Azure/DP-420.md": {
	id: "Azure/DP-420.md";
  slug: "azure/dp-420";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Azure/DP-500.md": {
	id: "Azure/DP-500.md";
  slug: "azure/dp-500";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Azure/DP-900.md": {
	id: "Azure/DP-900.md";
  slug: "azure/dp-900";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Dynamics 365/MB-210.md": {
	id: "Dynamics 365/MB-210.md";
  slug: "dynamics-365/mb-210";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Dynamics 365/MB-220.md": {
	id: "Dynamics 365/MB-220.md";
  slug: "dynamics-365/mb-220";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Dynamics 365/MB-230.md": {
	id: "Dynamics 365/MB-230.md";
  slug: "dynamics-365/mb-230";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Dynamics 365/MB-240.md": {
	id: "Dynamics 365/MB-240.md";
  slug: "dynamics-365/mb-240";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Dynamics 365/MB-260.md": {
	id: "Dynamics 365/MB-260.md";
  slug: "dynamics-365/mb-260";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Dynamics 365/MB-300.md": {
	id: "Dynamics 365/MB-300.md";
  slug: "dynamics-365/mb-300";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Dynamics 365/MB-310.md": {
	id: "Dynamics 365/MB-310.md";
  slug: "dynamics-365/mb-310";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Dynamics 365/MB-330.md": {
	id: "Dynamics 365/MB-330.md";
  slug: "dynamics-365/mb-330";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Dynamics 365/MB-335.md": {
	id: "Dynamics 365/MB-335.md";
  slug: "dynamics-365/mb-335";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Dynamics 365/MB-500.md": {
	id: "Dynamics 365/MB-500.md";
  slug: "dynamics-365/mb-500";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Dynamics 365/MB-700.md": {
	id: "Dynamics 365/MB-700.md";
  slug: "dynamics-365/mb-700";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Dynamics 365/MB-800.md": {
	id: "Dynamics 365/MB-800.md";
  slug: "dynamics-365/mb-800";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Dynamics 365/MB-910.md": {
	id: "Dynamics 365/MB-910.md";
  slug: "dynamics-365/mb-910";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Dynamics 365/MB-920.md": {
	id: "Dynamics 365/MB-920.md";
  slug: "dynamics-365/mb-920";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Microsoft 365/MD-102.md": {
	id: "Microsoft 365/MD-102.md";
  slug: "microsoft-365/md-102";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Microsoft 365/MS-102.md": {
	id: "Microsoft 365/MS-102.md";
  slug: "microsoft-365/ms-102";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Microsoft 365/MS-203.md": {
	id: "Microsoft 365/MS-203.md";
  slug: "microsoft-365/ms-203";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Microsoft 365/MS-700.md": {
	id: "Microsoft 365/MS-700.md";
  slug: "microsoft-365/ms-700";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Microsoft 365/MS-721.md": {
	id: "Microsoft 365/MS-721.md";
  slug: "microsoft-365/ms-721";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Microsoft 365/MS-900.md": {
	id: "Microsoft 365/MS-900.md";
  slug: "microsoft-365/ms-900";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"New Exam Template.md": {
	id: "New Exam Template.md";
  slug: "new-exam-template";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Power Platform/PL-100.md": {
	id: "Power Platform/PL-100.md";
  slug: "power-platform/pl-100";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Power Platform/PL-200.md": {
	id: "Power Platform/PL-200.md";
  slug: "power-platform/pl-200";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Power Platform/PL-300.md": {
	id: "Power Platform/PL-300.md";
  slug: "power-platform/pl-300";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Power Platform/PL-400.md": {
	id: "Power Platform/PL-400.md";
  slug: "power-platform/pl-400";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Power Platform/PL-500.md": {
	id: "Power Platform/PL-500.md";
  slug: "power-platform/pl-500";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Power Platform/PL-600.md": {
	id: "Power Platform/PL-600.md";
  slug: "power-platform/pl-600";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Power Platform/PL-900.md": {
	id: "Power Platform/PL-900.md";
  slug: "power-platform/pl-900";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Security, Compliance, and Identity/SC-100.md": {
	id: "Security, Compliance, and Identity/SC-100.md";
  slug: "security-compliance-and-identity/sc-100";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Security, Compliance, and Identity/SC-200.md": {
	id: "Security, Compliance, and Identity/SC-200.md";
  slug: "security-compliance-and-identity/sc-200";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Security, Compliance, and Identity/SC-300.md": {
	id: "Security, Compliance, and Identity/SC-300.md";
  slug: "security-compliance-and-identity/sc-300";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Security, Compliance, and Identity/SC-400.md": {
	id: "Security, Compliance, and Identity/SC-400.md";
  slug: "security-compliance-and-identity/sc-400";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"Security, Compliance, and Identity/SC-900.md": {
	id: "Security, Compliance, and Identity/SC-900.md";
  slug: "security-compliance-and-identity/sc-900";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"guide/1.introduction.md": {
	id: "guide/1.introduction.md";
  slug: "guide/1introduction";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"guide/2.overview.md": {
	id: "guide/2.overview.md";
  slug: "guide/2overview";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"guide/3.certificationprofile.md": {
	id: "guide/3.certificationprofile.md";
  slug: "guide/3certificationprofile";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"guide/4.voucherguide.md": {
	id: "guide/4.voucherguide.md";
  slug: "guide/4voucherguide";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"guide/5.certificationdashboard.md": {
	id: "guide/5.certificationdashboard.md";
  slug: "guide/5certificationdashboard";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"guide/6.howtotakemicrosoftexams.md": {
	id: "guide/6.howtotakemicrosoftexams.md";
  slug: "guide/6howtotakemicrosoftexams";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"guide/7.officialstudymaterials.md": {
	id: "guide/7.officialstudymaterials.md";
  slug: "guide/7officialstudymaterials";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"guide/8.studentoppurtunities.md": {
	id: "guide/8.studentoppurtunities.md";
  slug: "guide/8studentoppurtunities";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"guide/9.certificationrenewal.md": {
	id: "guide/9.certificationrenewal.md";
  slug: "guide/9certificationrenewal";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"guide/XI.microsoftpartneremployees.md": {
	id: "guide/XI.microsoftpartneremployees.md";
  slug: "guide/ximicrosoftpartneremployees";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"index.mdx": {
	id: "index.mdx";
  slug: "index";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".mdx"] };
"vouchers/Cloud Skills Challenges.md": {
	id: "vouchers/Cloud Skills Challenges.md";
  slug: "vouchers/cloud-skills-challenges";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"vouchers/Microsoft ESI.md": {
	id: "vouchers/Microsoft ESI.md";
  slug: "vouchers/microsoft-esi";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
"vouchers/MindHub Replay Voucher Bundles.md": {
	id: "vouchers/MindHub Replay Voucher Bundles.md";
  slug: "vouchers/mindhub-replay-voucher-bundles";
  body: string;
  collection: "docs";
  data: InferEntrySchema<"docs">
} & { render(): Render[".md"] };
};

	};

	type DataEntryMap = {
		
	};

	type AnyEntryMap = ContentEntryMap & DataEntryMap;

	type ContentConfig = typeof import("../src/content/config");
}
