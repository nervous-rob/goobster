import * as mssql from 'mssql';
import path from 'path';

const configPath = path.join(__dirname, '../../config.json');
const dbConfig = require(configPath).azureSql;

const config = {
  user: dbConfig.user,
  password: dbConfig.password,
  server: dbConfig.server,
  database: dbConfig.database,
  options: {
    encrypt: true,
    trustServerCertificate: true,
  }
};

let pool: mssql.ConnectionPool;

export async function getConnection() {
  try {
    if (!pool) {
      pool = await new mssql.ConnectionPool(config).connect();
    }
    return pool;
  } catch (error) {
    console.error('Database connection error:', error);
    throw error;
  }
}

export async function query<T>(
  strings: TemplateStringsArray, 
  ...values: any[]
): Promise<mssql.IResult<T>> {
  const conn = await getConnection();
  const request = new mssql.Request(conn);
  
  // Combine the strings and values to create the complete query
  let query = strings[0];
  for (let i = 0; i < values.length; i++) {
    // Add the parameter
    const paramName = `p${i}`;
    request.input(paramName, values[i]);
    query += `@${paramName}` + strings[i + 1];
  }
  
  return request.query(query);
}

export async function queryWithTransaction<T>(
  transaction: mssql.Transaction,
  strings: string[],
  ...values: any[]
): Promise<mssql.IResult<T>> {
  const request = new mssql.Request(transaction);
  
  // The query is the first (and only) string in the array
  const query = strings[0];
  
  // Add parameters
  for (let i = 0; i < values.length; i++) {
    const paramName = `p${i}`;
    request.input(paramName, values[i]);
  }
  
  return request.query(query);
} 