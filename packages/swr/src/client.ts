import type {
  ClientHeaderBuilder,
  GeneratorDependency,
  GeneratorMutator,
  GeneratorOptions,
  GeneratorVerbOptions,
  GetterResponse,
} from '@orval/core';
import {
  generateFormDataAndUrlEncodedFunction,
  generateMutatorConfig,
  generateOptions,
  isSyntheticDefaultImportsAllow,
  OutputHttpClient,
  pascal,
  resolveRef,
  toObjectString,
} from '@orval/core';
import {
  fetchResponseTypeName,
  generateFetchHeader,
  generateRequestFunction as generateFetchRequestFunction,
} from '@orval/fetch';
import type {
  ParameterObject,
  PathItemObject,
  ReferenceObject,
} from 'openapi3-ts/oas30';

export const AXIOS_DEPENDENCIES: GeneratorDependency[] = [
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
      { name: 'AxiosError' },
    ],
    dependency: 'axios',
  },
];

export const generateSwrRequestFunction = (
  verbOptions: GeneratorVerbOptions,
  options: GeneratorOptions,
) => {
  return options.context.output.httpClient === OutputHttpClient.AXIOS
    ? generateAxiosRequestFunction(verbOptions, options)
    : generateFetchRequestFunction(verbOptions, options);
};

const generateAxiosRequestFunction = (
  {
    headers,
    queryParams,
    operationName,
    response,
    mutator,
    body,
    props,
    verb,
    formData,
    formUrlEncoded,
    override,
    paramsSerializer,
  }: GeneratorVerbOptions,
  { route, context, pathRoute }: GeneratorOptions,
) => {
  const isRequestOptions = override.requestOptions !== false;
  const isFormData = !override.formData.disabled;
  const isFormUrlEncoded = override.formUrlEncoded !== false;
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

    const propsImplementationBase =
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
      )?.schema.name as string | undefined;
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
      const braceParams = (route.match(/\{([^}]+)\}/g) || [])
        .map((s) => s.slice(1, -1))
        .filter(Boolean);
      const templateParams = (route.match(/\$\{([^}]+)\}/g) || []).map((s) =>
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

      const fn = `export const ${operationName} = (\n    request: ${requestTypeName}${
        isRequestOptions && mutator.hasSecondArg
          ? `, options${context.output.optionsParamRequired ? '' : '?'}: SecondParameter<typeof ${mutator.name}>`
          : ''
      }\n ) => {${destructLine}
    ${bodyFormReplaced}
  ${paramsInit}
  ${headersInit}
    return ${mutator.name}<${response.definition.success || 'unknown'}>(
    ${mutatorConfig},
    ${isRequestOptions && mutator.hasSecondArg ? 'options' : ''});
  }\n`;

      return `${fn}\n${requestTypeDef}${pathParamsTypeDef ? `\n${pathParamsTypeDef}` : ''}`;
    }

    return `export const ${operationName} = (\n    ${propsImplementationBase}\n ${
      isRequestOptions && mutator.hasSecondArg
        ? `options${context.output.optionsParamRequired ? '' : '?'}: SecondParameter<typeof ${mutator.name}>`
        : ''
    }) => {${bodyForm}
      return ${mutator.name}<${response.definition.success || 'unknown'}>(
      ${mutatorConfig},
      ${isRequestOptions && mutator.hasSecondArg ? 'options' : ''});
    }
  `;
  }

  const optionsCfg = generateOptions({
    route,
    body:
      useSingleRequestArg && body.definition
        ? { ...body, implementation: 'data' }
        : body,
    headers,
    queryParams,
    response,
    verb,
    requestOptions: override.requestOptions,
    isFormData,
    isFormUrlEncoded,
    paramsSerializer,
    paramsSerializerOptions: override.paramsSerializerOptions,
    isExactOptionalPropertyTypes,
    hasSignal: false,
  });

  if (useSingleRequestArg) {
    // Collect param names for destructuring and building params/headers
    const spec = context.specs[context.specKey].paths[pathRoute] as
      | PathItemObject
      | undefined;
    const parameters =
      (spec?.[verb as keyof PathItemObject] as any)?.parameters ||
      ([] as (ParameterObject | ReferenceObject)[]);
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
    const namedPathParamSchema = props.find((p) => p.type === 'namedPathParams')
      ?.schema.name as string | undefined;
    if (namedPathParamSchema) {
      intersectionParts.push(namedPathParamSchema);
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
    const braceParamsAll = (route.match(/\{([^}]+)\}/g) || [])
      .map((s) => s.slice(1, -1))
      .filter(Boolean);
    const templateParamsAll = (route.match(/\$\{([^}]+)\}/g) || []).map((s) =>
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
    const namedSchemaModelAll = namedPropAll?.schema?.model as
      | string
      | undefined;
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

    return (
      `export const ${operationName} = (\n    request: ${requestTypeName}${
        isRequestOptions ? `, options?: AxiosRequestConfig` : ''
      }\n  ): Promise<AxiosResponse<${response.definition.success || 'unknown'}>> => {${destructLineAll}
    ${bodyFormReplaced}
  ${paramsInit}
  ${headersInit}
    return axios${
      isSyntheticDefaultImportsAllowed ? '' : '.default'
    }.${verb}(${optionsCfg});
  }\n` +
      `\n${requestTypeDef}${pathParamsTypeDef ? `\n${pathParamsTypeDef}` : ''}`
    );
  }

  return `export const ${operationName} = (\n    ${toObjectString(
    props,
    'implementation',
  )} ${
    isRequestOptions ? `options?: AxiosRequestConfig\n` : ''
  } ): Promise<AxiosResponse<${
    response.definition.success || 'unknown'
  }>> => {${bodyForm}
    return axios${
      isSyntheticDefaultImportsAllowed ? '' : '.default'
    }.${verb}(${optionsCfg});
  }
`;
};

export const getSwrRequestOptions = (
  httpClient: OutputHttpClient,
  mutator?: GeneratorMutator,
) => {
  if (!mutator) {
    return httpClient === OutputHttpClient.AXIOS
      ? 'axios?: AxiosRequestConfig'
      : 'fetch?: RequestInit';
  } else if (mutator?.hasSecondArg) {
    return `request?: SecondParameter<typeof ${mutator.name}>`;
  } else {
    return '';
  }
};

export const getSwrErrorType = (
  response: GetterResponse,
  httpClient: OutputHttpClient,
  mutator?: GeneratorMutator,
) => {
  if (mutator) {
    return mutator.hasErrorType
      ? `ErrorType<${response.definition.errors || 'unknown'}>`
      : response.definition.errors || 'unknown';
  } else {
    const errorType =
      httpClient === OutputHttpClient.AXIOS ? 'AxiosError' : 'Promise';

    return `${errorType}<${response.definition.errors || 'unknown'}>`;
  }
};

export const getSwrRequestSecondArg = (
  httpClient: OutputHttpClient,
  mutator?: GeneratorMutator,
) => {
  if (!mutator) {
    return httpClient === OutputHttpClient.AXIOS
      ? 'axios: axiosOptions'
      : 'fetch: fetchOptions';
  } else if (mutator?.hasSecondArg) {
    return 'request: requestOptions';
  } else {
    return '';
  }
};

export const getHttpRequestSecondArg = (
  httpClient: OutputHttpClient,
  mutator?: GeneratorMutator,
) => {
  if (!mutator) {
    return httpClient === OutputHttpClient.AXIOS
      ? `axiosOptions`
      : `fetchOptions`;
  } else if (mutator?.hasSecondArg) {
    return 'requestOptions';
  } else {
    return '';
  }
};

export const getSwrMutationFetcherOptionType = (
  httpClient: OutputHttpClient,
  mutator?: GeneratorMutator,
) => {
  if (!mutator) {
    return httpClient === OutputHttpClient.AXIOS
      ? 'AxiosRequestConfig'
      : 'RequestInit';
  } else if (mutator.hasSecondArg) {
    return `SecondParameter<typeof ${mutator.name}>`;
  } else {
    return '';
  }
};

export const getSwrMutationFetcherType = (
  response: GetterResponse,
  httpClient: OutputHttpClient,
  includeHttpResponseReturnType: boolean | undefined,
  operationName: string,
  mutator?: GeneratorMutator,
) => {
  if (httpClient === OutputHttpClient.FETCH) {
    const responseType = fetchResponseTypeName(
      includeHttpResponseReturnType,
      response.definition.success,
      operationName,
    );

    return `Promise<${responseType}>`;
  } else if (mutator) {
    return `Promise<${response.definition.success || 'unknown'}>`;
  } else {
    return `Promise<AxiosResponse<${response.definition.success || 'unknown'}>>`;
  }
};

export const getSwrHeader: ClientHeaderBuilder = (params) => {
  return params.output.httpClient === OutputHttpClient.FETCH
    ? generateFetchHeader(params)
    : '';
};
