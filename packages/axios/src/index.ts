import {
  ClientBuilder,
  ClientDependenciesBuilder,
  ClientFooterBuilder,
  ClientGeneratorsBuilder,
  ClientHeaderBuilder,
  ClientTitleBuilder,
  generateFormDataAndUrlEncodedFunction,
  generateMutatorConfig,
  generateMutatorRequestOptions,
  generateOptions,
  generateVerbImports,
  GeneratorDependency,
  GeneratorOptions,
  GeneratorVerbOptions,
  isSyntheticDefaultImportsAllow,
  pascal,
  resolveRef,
  sanitize,
  toObjectString,
} from '@orval/core';
import type {
  ParameterObject,
  PathItemObject,
  ReferenceObject,
} from 'openapi3-ts/oas30';

const AXIOS_DEPENDENCIES: GeneratorDependency[] = [
  {
    exports: [
      {
        name: 'axios',
        default: true,
        values: true,
        syntheticDefaultImport: true,
      },
      { name: 'AxiosRequestConfig' },
      { name: 'AxiosResponse' },
    ],
    dependency: 'axios',
  },
];

const PARAMS_SERIALIZER_DEPENDENCIES: GeneratorDependency[] = [
  {
    exports: [
      {
        name: 'qs',
        default: true,
        values: true,
        syntheticDefaultImport: true,
      },
    ],
    dependency: 'qs',
  },
];

const returnTypesToWrite = new Map<string, (title?: string) => string>();

export const getAxiosDependencies: ClientDependenciesBuilder = (
  hasGlobalMutator,
  hasParamsSerializerOptions: boolean,
) => [
  ...(hasGlobalMutator ? [] : AXIOS_DEPENDENCIES),
  ...(hasParamsSerializerOptions ? PARAMS_SERIALIZER_DEPENDENCIES : []),
];

const generateAxiosImplementation = (
  {
    headers,
    queryParams,
    operationName,
    response,
    mutator,
    body,
    props,
    verb,
    override,
    formData,
    formUrlEncoded,
    paramsSerializer,
  }: GeneratorVerbOptions,
  { route, context, pathRoute }: GeneratorOptions,
) => {
  const isRequestOptions = override?.requestOptions !== false;
  const isFormData = !override?.formData.disabled;
  const isFormUrlEncoded = override?.formUrlEncoded !== false;
  const isExactOptionalPropertyTypes =
    !!context.output.tsconfig?.compilerOptions?.exactOptionalPropertyTypes;
  const usesFormPayload =
    (isFormData && Boolean(body.formData)) ||
    (isFormUrlEncoded && Boolean(body.formUrlEncoded));

  const isSyntheticDefaultImportsAllowed = isSyntheticDefaultImportsAllow(
    context.output.tsconfig,
  );

  const bodyForm = generateFormDataAndUrlEncodedFunction({
    formData,
    formUrlEncoded,
    body,
    isFormData,
    isFormUrlEncoded,
  });

  // tolerate mixed type versions by using a safe access
  const useSingleRequestArg = override.useSingleRequestArgument;
  const bodyFormReplaced =
    useSingleRequestArg && body.definition
      ? bodyForm.replaceAll(body.implementation, 'request')
      : bodyForm;

  if (mutator) {
    // Collect param names for destructuring and building params/headers
    const spec = context.specs[context.specKey].paths[pathRoute] as
      | PathItemObject
      | undefined;
    const parameters = (spec?.[verb as keyof PathItemObject]?.parameters ??
      []) as (ParameterObject | ReferenceObject)[];
    const queryParamNames = parameters
      .map((p) => resolveRef<ParameterObject>(p, context).schema)
      .filter((s) => s.in === 'query')
      .map((s) => s.name);
    const headerParamNames = parameters
      .map((p) => resolveRef<ParameterObject>(p, context).schema)
      .filter((s) => s.in === 'header')
      .map((s) => s.name)
      // filter out invalid identifiers to be safe
      .filter((n) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n));
    const pathParamNames = props
      .filter((p) => p.type === 'param')
      .map((p) => p.name as string);

    const mutatorConfig = generateMutatorConfig({
      route,
      body:
        useSingleRequestArg && body.definition
          ? { ...body, implementation: 'data' }
          : body,
      headers,
      queryParams,
      response,
      verb,
      isFormData,
      isFormUrlEncoded,
      hasSignal: false,
      isExactOptionalPropertyTypes,
    });

    const requestOptions = isRequestOptions
      ? generateMutatorRequestOptions(
          override?.requestOptions,
          mutator.hasSecondArg,
        )
      : '';

    returnTypesToWrite.set(
      operationName,
      (title?: string) =>
        `export type ${pascal(
          operationName,
        )}Result = NonNullable<Awaited<ReturnType<${
          title
            ? `ReturnType<typeof ${title}>['${operationName}']`
            : `typeof ${operationName}`
        }>>>`,
    );

    const propsImplementation =
      mutator.bodyTypeName && body.definition
        ? toObjectString(props, 'implementation').replace(
            new RegExp(`(\\w*):\\s?${body.definition}`),
            `$1: ${mutator.bodyTypeName}<${body.definition}>`,
          )
        : toObjectString(props, 'implementation');

    if (useSingleRequestArg) {
      const requestTypeName = `${pascal(operationName)}Request`;
      const intersectionParts: string[] = [];
      if (body.definition) intersectionParts.push(body.definition);
      if (queryParams) intersectionParts.push(queryParams.schema.name);
      if (headers) intersectionParts.push(headers.schema.name);
      let pathParamsTypeName = '';
      let pathParamsTypeDef = '';
      const namedPathParamSchema = props.find(
        (p) => p.type === 'namedPathParams',
      )?.schema.name;
      if (namedPathParamSchema) {
        intersectionParts.push(namedPathParamSchema);
      } else if (pathParamNames.length > 0) {
        // fallback: inline object when no named schema is available
        const pathDefs = props
          .filter((p) => p.type === 'param')
          .map((p) => p.definition)
          .join(',\n ');
        pathParamsTypeName = `${pascal(operationName)}PathParams`;
        pathParamsTypeDef = `export type ${pathParamsTypeName} = {\n ${pathDefs}\n }`;
        intersectionParts.push(pathParamsTypeName);
      }
      const requestTypeDef = `export type ${requestTypeName} = Expand<${
        intersectionParts.length > 0
          ? intersectionParts.join(' & ')
          : 'Record<string, never>'
      }>`;

      const isValidIdent = (n: string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n);
      const braceParams = (pathRoute.match(/\{([^}]+)\}/g) ?? [])
        .map((s) => s.slice(1, -1))
        .filter(Boolean);
      const templateParams = (route.match(/\$\{([^}]+)\}/g) ?? []).map((s) =>
        s.slice(2, -1),
      );
      const routeParamNames = [
        ...new Set([...braceParams, ...templateParams]),
      ].filter((element) => isValidIdent(element));
      const validQuery = queryParamNames.filter((element) =>
        isValidIdent(element),
      );
      const validHeader = headerParamNames.filter((element) =>
        isValidIdent(element),
      );
      const namedProp = props.find((p) => p.type === 'namedPathParams');
      const namedDestruct =
        namedProp?.destructured
          .replaceAll(/[{}]/g, '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean) ?? [];
      const namedSchemaModel = namedProp?.schema.model;
      const namesFromModel =
        namedDestruct.length === 0 && namedSchemaModel
          ? [
              ...namedSchemaModel.matchAll(
                /\n\s*([A-Za-z_$][A-Za-z0-9_$]*)\??:/g,
              ),
            ].map((m) => m[1])
          : [];
      const destructNames = [
        ...new Set<string>([
          ...pathParamNames,
          ...routeParamNames,
          ...namedDestruct,
          ...namesFromModel,
          ...validQuery,
          ...validHeader,
        ]),
      ];
      const destruct = destructNames.join(', ');
      const hasDataSpread = Boolean(body.definition && !usesFormPayload);
      const hasDestructNames = destruct.length > 0;
      const destructContent =
        hasDestructNames && hasDataSpread
          ? `${destruct}, ...data`
          : hasDestructNames
            ? destruct
            : hasDataSpread
              ? '...data'
              : '';
      const destructLine = destructContent
        ? `\n  const { ${destructContent} } = request;`
        : '';

      const paramsInit = queryParams
        ? `const params = { ${queryParamNames
            .map((n: string) =>
              isValidIdent(n) ? n : `'${n}': request['${n}']`,
            )
            .join(', ')} };`
        : '';
      const headersInit = headers
        ? `const headers = { ${headerParamNames
            .map((n: string) =>
              isValidIdent(n) ? n : `'${n}': request['${n}']`,
            )
            .join(', ')} };`
        : '';

      const fn = `const ${operationName} = (\n    request: ${requestTypeName}${
        isRequestOptions && mutator.hasSecondArg
          ? `, options${context.output.optionsParamRequired ? '' : '?'}: SecondParameter<typeof ${mutator.name}<${
              response.definition.success || 'unknown'
            }>>`
          : ''
      }\n ) => {${destructLine}
    ${bodyFormReplaced}
  ${paramsInit}
  ${headersInit}
      return ${mutator.name}<${response.definition.success || 'unknown'}>(
      ${mutatorConfig},
      ${isRequestOptions && mutator.hasSecondArg ? 'options' : ''});
    }\n`;

      // Ensure function is exported by placing it first (the caller prefixes implementation with 'export ')
      return `${fn}\n${requestTypeDef}${pathParamsTypeDef ? `\n${pathParamsTypeDef}` : ''}`;
    }

    return `const ${operationName} = (\n    ${propsImplementation}\n ${
      isRequestOptions && mutator.hasSecondArg
        ? `options${context.output.optionsParamRequired ? '' : '?'}: SecondParameter<typeof ${mutator.name}<${response.definition.success || 'unknown'}>>,`
        : ''
    }) => {${bodyForm}
      return ${mutator.name}<${response.definition.success || 'unknown'}>(
      ${mutatorConfig},
      ${requestOptions});
    }
  `;
  }

  const options = generateOptions({
    route,
    body:
      useSingleRequestArg && body.definition
        ? { ...body, implementation: 'data' }
        : body,
    headers,
    queryParams,
    response,
    verb,
    requestOptions: override?.requestOptions,
    isFormData,
    isFormUrlEncoded,
    paramsSerializer,
    paramsSerializerOptions: override?.paramsSerializerOptions,
    isExactOptionalPropertyTypes,
    hasSignal: false,
  });

  returnTypesToWrite.set(
    operationName,
    () =>
      `export type ${pascal(operationName)}Result = AxiosResponse<${
        response.definition.success || 'unknown'
      }>`,
  );

  if (useSingleRequestArg) {
    // Collect param names for destructuring and building params/headers
    const spec = context.specs[context.specKey].paths[pathRoute] as
      | PathItemObject
      | undefined;
    const parameters = (spec?.[verb as keyof PathItemObject]?.parameters ??
      []) as (ParameterObject | ReferenceObject)[];
    const queryParamNames = parameters
      .map((p) => resolveRef<ParameterObject>(p, context).schema)
      .filter((s) => s.in === 'query')
      .map((s) => s.name);
    const headerParamNames = parameters
      .map((p) => resolveRef<ParameterObject>(p, context).schema)
      .filter((s) => s.in === 'header')
      .map((s) => s.name)
      .filter((n) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n));
    const pathParamNames = props
      .filter((p) => p.type === 'param')
      .map((p) => p.name as string);

    const requestTypeName = `${pascal(operationName)}Request`;
    const intersectionParts: string[] = [];
    if (body.definition) intersectionParts.push(body.definition);
    if (queryParams) intersectionParts.push(queryParams.schema.name);
    if (headers) intersectionParts.push(headers.schema.name);
    let pathParamsTypeName = '';
    let pathParamsTypeDef = '';
    const namedPathParamSchemaNonMut = props.find(
      (p) => p.type === 'namedPathParams',
    )?.schema.name;
    if (namedPathParamSchemaNonMut) {
      intersectionParts.push(namedPathParamSchemaNonMut);
    } else if (pathParamNames.length > 0) {
      const pathDefs = props
        .filter((p) => p.type === 'param')
        .map((p) => p.definition)
        .join(',\n ');
      pathParamsTypeName = `${pascal(operationName)}PathParams`;
      pathParamsTypeDef = `export type ${pathParamsTypeName} = {\n ${pathDefs}\n }`;
      intersectionParts.push(pathParamsTypeName);
    }
    const requestTypeDef = `export type ${requestTypeName} = Expand<${
      intersectionParts.length > 0
        ? intersectionParts.join(' & ')
        : 'Record<string, never>'
    }>`;

    const isValidIdent = (n: string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n);
    const braceParamsAll = (pathRoute.match(/\{([^}]+)\}/g) ?? [])
      .map((s) => s.slice(1, -1))
      .filter(Boolean);
    const templateParamsAll = (route.match(/\$\{([^}]+)\}/g) ?? []).map((s) =>
      s.slice(2, -1),
    );
    const routeParamNames = [
      ...new Set([...braceParamsAll, ...templateParamsAll]),
    ].filter((element) => isValidIdent(element));
    const validQuery = queryParamNames.filter((element) =>
      isValidIdent(element),
    );
    const validHeader = headerParamNames.filter((element) =>
      isValidIdent(element),
    );
    const namedPropAll = props.find((p) => p.type === 'namedPathParams');
    const namedDestructAll =
      namedPropAll?.destructured
        .replaceAll(/[{}]/g, '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean) ?? [];
    const namedSchemaModelAll = namedPropAll?.schema.model;
    const namesFromModelAll =
      namedDestructAll.length === 0 && namedSchemaModelAll
        ? [
            ...namedSchemaModelAll.matchAll(
              /\n\s*([A-Za-z_$][A-Za-z0-9_$]*)\??:/g,
            ),
          ].map((m) => m[1])
        : [];
    const destructAllArray = [
      ...new Set<string>([
        ...pathParamNames,
        ...routeParamNames,
        ...namedDestructAll,
        ...namesFromModelAll,
        ...validQuery,
        ...validHeader,
      ]),
    ];
    const destructAll = destructAllArray.join(', ');
    const hasDataSpreadAll = Boolean(body.definition && !usesFormPayload);
    const hasDestructNamesAll = destructAll.length > 0;
    const destructContentAll =
      hasDestructNamesAll && hasDataSpreadAll
        ? `${destructAll}, ...data`
        : hasDestructNamesAll
          ? destructAll
          : hasDataSpreadAll
            ? '...data'
            : '';
    const destructLineAll = destructContentAll
      ? `\n  const { ${destructContentAll} } = request;`
      : '';
    const paramsInit = queryParams
      ? `const params = { ${queryParamNames
          .map((n: string) => (isValidIdent(n) ? n : `'${n}': request['${n}']`))
          .join(', ')} };`
      : '';
    const headersInit = headers
      ? `const headers = { ${headerParamNames
          .map((n: string) => (isValidIdent(n) ? n : `'${n}': request['${n}']`))
          .join(', ')} };`
      : '';

    // Ensure function is exported by placing it first (the caller prefixes implementation with 'export ')
    const hasRequest = intersectionParts.length > 0;
    return hasRequest
      ? `const ${operationName} = <TData = AxiosResponse<${
          response.definition.success || 'unknown'
        }>>(\n    request: ${requestTypeName}${isRequestOptions ? `, options?: AxiosRequestConfig` : ''}\n  ): Promise<TData> => {${destructLineAll}
    ${bodyFormReplaced}
  ${paramsInit}
  ${headersInit}
    return axios${
      isSyntheticDefaultImportsAllowed ? '' : '.default'
    }.${verb}(${options});
  }
\n${requestTypeDef}${pathParamsTypeDef ? `\n${pathParamsTypeDef}` : ''}
`
      : `const ${operationName} = <TData = AxiosResponse<${
          response.definition.success || 'unknown'
        }>>(${isRequestOptions ? `options?: AxiosRequestConfig` : ''}): Promise<TData> => {${bodyForm}
    return axios${
      isSyntheticDefaultImportsAllowed ? '' : '.default'
    }.${verb}(${options});
  }
`;
  }

  return `const ${operationName} = <TData = AxiosResponse<${
    response.definition.success || 'unknown'
  }>>(\n    ${toObjectString(props, 'implementation')} ${
    isRequestOptions ? `options?: AxiosRequestConfig\n` : ''
  } ): Promise<TData> => {${bodyForm}
      return axios${
        isSyntheticDefaultImportsAllowed ? '' : '.default'
      }.${verb}(${options});
    }
`;
};

export const generateAxiosTitle: ClientTitleBuilder = (title) => {
  const sanTitle = sanitize(title);
  return `get${pascal(sanTitle)}`;
};

export const generateAxiosHeader: ClientHeaderBuilder = ({
  title,
  isRequestOptions,
  isMutator,
  noFunction,
}) => `
${
  isRequestOptions && isMutator
    ? `type SecondParameter<T extends (...args: never) => unknown> = Parameters<T>[1];\n\n`
    : ''
}
  ${noFunction ? '' : `export const ${title} = () => {\n`}`;

export const generateAxiosFooter: ClientFooterBuilder = ({
  operationNames,
  title,
  noFunction,
  hasMutator,
  hasAwaitedType,
}) => {
  let footer = '';

  if (!noFunction) {
    footer += `return {${operationNames.join(',')}}};\n`;
  }

  if (hasMutator && !hasAwaitedType) {
    footer += `\ntype AwaitedInput<T> = PromiseLike<T> | T;\n
    type Awaited<O> = O extends AwaitedInput<infer T> ? T : never;
\n`;
  }

  for (const operationName of operationNames) {
    if (returnTypesToWrite.has(operationName)) {
      const func = returnTypesToWrite.get(operationName)!;
      footer += func(noFunction ? undefined : title) + '\n';
    }
  }

  return footer;
};

export const generateAxios = (
  verbOptions: GeneratorVerbOptions,
  options: GeneratorOptions,
) => {
  const imports = generateVerbImports(verbOptions);
  const implementation = generateAxiosImplementation(verbOptions, options);

  return { implementation, imports };
};

export const generateAxiosFunctions: ClientBuilder = async (
  verbOptions,
  options,
) => {
  const { implementation, imports } = generateAxios(verbOptions, options);

  return {
    implementation: 'export ' + implementation,
    imports,
  };
};

const axiosClientBuilder: ClientGeneratorsBuilder = {
  client: generateAxios,
  header: generateAxiosHeader,
  dependencies: getAxiosDependencies,
  footer: generateAxiosFooter,
  title: generateAxiosTitle,
};

const axiosFunctionsClientBuilder: ClientGeneratorsBuilder = {
  client: generateAxiosFunctions,
  header: (options) => generateAxiosHeader({ ...options, noFunction: true }),
  dependencies: getAxiosDependencies,
  footer: (options) => generateAxiosFooter({ ...options, noFunction: true }),
  title: generateAxiosTitle,
};

const builders: Record<'axios' | 'axios-functions', ClientGeneratorsBuilder> = {
  axios: axiosClientBuilder,
  'axios-functions': axiosFunctionsClientBuilder,
};

export const builder =
  ({ type = 'axios-functions' }: { type?: 'axios' | 'axios-functions' } = {}) =>
  () =>
    builders[type];

export default builder;
