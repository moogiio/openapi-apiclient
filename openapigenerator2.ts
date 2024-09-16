import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { generateSchemasFile } from './generateSchemas';

  interface Arguments {
    input: string;
    output: string;
  }
  const argv = yargs(hideBin(process.argv))
  .option('input', {
    alias: 'i',
    description: 'The URL or file path to the OpenAPI specification',
    type: 'string',
    demandOption: true,
  })
  .option('output', {
    alias: 'o',
    description: 'The output directory for the generated files',
    type: 'string',
    default: './__generated__',
  })
  .help()
  .alias('help', 'h')
  .parse() as Arguments;

// Types for OpenAPI Specification
interface OpenAPISpec {
  paths: Record<string, PathMethods>;
}

interface PathMethods {
  [method: string]: Operation;
}

interface Operation {
  parameters?: Parameter[];
  requestBody?: unknown;
}

interface Parameter {
  in: string;
  name: string;
}

// Function to fetch OpenAPI specification from a URL
async function fetchOpenAPISpec(url: string): Promise<OpenAPISpec> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch OpenAPI spec: ${response.statusText}`);
    }
    return( await response.json()) as OpenAPISpec;
  } catch (error) {
    console.error('Error fetching OpenAPI spec:', error);
    process.exit(1);
  }
}

// Function to read OpenAPI specification from a local file
async function readOpenAPISpecFromFile(filePath: string): Promise<OpenAPISpec> {
  try {
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(fileContent);
  } catch (error) {
    console.error('Error reading OpenAPI spec from file:', error);
    process.exit(1);
  }
}

// Function to determine if the input is a URL
function isUrl(input: string): boolean {
  try {
    new URL(input);
    return true;
  } catch (_) {
    return false;
  }
}

// Function to extract the common base path from OpenAPI paths
function extractCommonBasePath(paths: string[]): string {
  if (paths.length === 0) return '';
  const commonPrefix = findCommonPrefix(paths);
  return commonPrefix.endsWith('/') ? commonPrefix.slice(0, -1) : commonPrefix;
}

// Function to find the common prefix of an array of strings
function findCommonPrefix(strings: string[]): string {
  if (strings.length === 0) return '';
  let prefix = strings[0];
  for (let i = 1; i < strings.length; i++) {
    while (strings[i].indexOf(prefix) !== 0) {
      prefix = prefix.substring(0, prefix.length - 1);
      if (prefix === '') return '';
    }
  }
  return prefix;
}

// Function to generate the client.ts content
function generateClientContent(): string {
  return `type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

interface ApiClientOptions {
  baseUrl: string;
}

interface RequestOptions<T> {
  method: HttpMethod;
  path: string;
  body?: T;
}

class ApiClient {
  private baseUrl: string;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl;
  }

  async request<TResponse, TRequest = undefined>(options: RequestOptions<TRequest>): Promise<TResponse> {
    const { method, path, body } = options;
    const url = \`\${this.baseUrl}\${path}\`;
    const fetchOptions: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (body) {
      fetchOptions.body = JSON.stringify(body);
    }

    try {
      const response = await fetch(url, fetchOptions);
      if (!response.ok) {
        throw new Error(\`HTTP error! Status: \${response.status}\`);
      }
      return (await response.json()) as TResponse;
    } catch (error) {
      console.error('API request failed:', error);
      throw error;
    }
  }

  get<TResponse>(path: string): Promise<TResponse> {
    return this.request<TResponse>({ method: 'GET', path });
  }

  post<TResponse, TRequest>(path: string, body: TRequest): Promise<TResponse> {
    return this.request<TResponse, TRequest>({ method: 'POST', path, body });
  }

  put<TResponse, TRequest>(path: string, body: TRequest): Promise<TResponse> {
    return this.request<TResponse, TRequest>({ method: 'PUT', path, body });
  }

  delete<TResponse>(path: string): Promise<TResponse> {
    return this.request<TResponse>({ method: 'DELETE', path });
  }
}

export const apiClient = new ApiClient({ baseUrl: '' }); // Base URL will be set dynamically
`;
}

// Function to generate the routes.api.ts content
function generateRoutesContent(spec: OpenAPISpec, baseUrl: string): string {
  const functions: string[] = [];
  functions.push(`import { apiClient } from './client';\n`);

  for (const [path, methods] of Object.entries(spec.paths)) {
    const relativePath = path.replace(baseUrl, '');  // Remove the base path dynamically
    for (const [method, operation] of Object.entries(methods as PathMethods)) {
      const functionName = `${method.toLowerCase()}${capitalizeCamelCase(relativePath)}`;
      const params = operation.parameters?.filter((p: Parameter) => p.in === 'path').map((p: Parameter) => p.name) || [];
      const hasRequestBody = !!operation.requestBody;

      let functionDefinition = `export async function ${functionName}(`;
      if (params.length > 0) {
        functionDefinition += params.join(', ') + (hasRequestBody ? ', ' : '');
      }
      if (hasRequestBody) {
        functionDefinition += 'requestBody: any';
      }
      functionDefinition += `): Promise<any> {`;
      functions.push(functionDefinition);

      let apiPath = `'${relativePath}'`;
      if (params.length > 0) {
        apiPath = '`' + relativePath.replace(/{/g, '${') + '`';
      }

      if (hasRequestBody) {
        functions.push(`  return apiClient.${method.toLowerCase()}(${apiPath}, requestBody);`);
      } else {
        functions.push(`  return apiClient.${method.toLowerCase()}(${apiPath});`);
      }
      functions.push(`}\n`);
    }
  }

  return functions.join('\n');
}

function capitalizeCamelCase(str: string): string {
  return str
    .replace(/^\//, '') // Remove leading slash
    .replace(/{([^}]+)}/g, '$1') // Remove curly braces from path parameters
    .split(/[^a-zA-Z0-9]+/) // Split on non-alphanumeric characters
    .map((part, index) => 
      part.charAt(0).toUpperCase() + part.slice(1) // Capitalize first letter of each part
    )
    .join('');
}

async function main() {
  const { input, output } = argv;

  // Determine if the input is a URL or a file path
  let spec: OpenAPISpec;
  if (isUrl(input as string)) {
    spec = await fetchOpenAPISpec(input as string);
  } else {
    spec = await readOpenAPISpecFromFile(input as string);
  }

  // Determine the common base path
  const baseUrl = extractCommonBasePath(Object.keys(spec.paths));

  // Generate content for client.ts and routes.api.ts
  const clientContent = generateClientContent();
  const routesContent = generateRoutesContent(spec, baseUrl);

  // Create output directory if it does not exist
  const outputDir = path.resolve(process.cwd(), output as string);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write the generated files
  fs.writeFileSync(path.join(outputDir, 'client.ts'), clientContent, 'utf-8');
  fs.writeFileSync(path.join(outputDir, 'routes.api.ts'), routesContent, 'utf-8');

  // Generate and write schemas.api.ts
  generateSchemasFile(spec, outputDir);

  console.log(`API client, routes, and schemas have been generated in ${outputDir}`);
}

main();
