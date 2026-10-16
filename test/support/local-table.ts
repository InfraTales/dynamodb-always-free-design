/**
 * Creates the table in DynamoDB Local from the same schema and plan the CDK stack uses.
 * The SDK finds Local through the standard AWS_ENDPOINT_URL_DYNAMODB variable.
 */
import { randomUUID } from 'node:crypto';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, type CreateTableCommandInput } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CAPACITY_PLAN } from '../../src/capacity-plan';
import { INDEXES, TABLE_KEYS } from '../../src/schema';
import type { Item } from '../../src/capacity';

export function localClients() {
  if (!process.env.AWS_ENDPOINT_URL_DYNAMODB) {
    throw new Error('Set AWS_ENDPOINT_URL_DYNAMODB, for example http://localhost:8013, and start DynamoDB Local');
  }
  const client = new DynamoDBClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    // DynamoDB Local accepts any credentials, so these are dummies.
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  return { client, doc: DynamoDBDocumentClient.from(client) };
}

export function createTableInput(tableName: string): CreateTableCommandInput {
  const attributes = new Set<string>([TABLE_KEYS.partitionKey, TABLE_KEYS.sortKey]);
  INDEXES.forEach((i) => { attributes.add(i.partitionKey); attributes.add(i.sortKey); });
  return {
    TableName: tableName,
    BillingMode: 'PROVISIONED',
    // Local ignores these numbers. They're here so the input matches what we deploy.
    ProvisionedThroughput: { ReadCapacityUnits: CAPACITY_PLAN.table.read, WriteCapacityUnits: CAPACITY_PLAN.table.write.max },
    AttributeDefinitions: [...attributes].map((name) => ({ AttributeName: name, AttributeType: 'S' })),
    KeySchema: [
      { AttributeName: TABLE_KEYS.partitionKey, KeyType: 'HASH' },
      { AttributeName: TABLE_KEYS.sortKey, KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: INDEXES.map((i) => ({
      IndexName: i.name,
      KeySchema: [
        { AttributeName: i.partitionKey, KeyType: 'HASH' },
        { AttributeName: i.sortKey, KeyType: 'RANGE' },
      ],
      Projection: i.projection.type === 'INCLUDE'
        ? { ProjectionType: 'INCLUDE', NonKeyAttributes: [...i.projection.attributes] }
        : { ProjectionType: i.projection.type },
      ProvisionedThroughput: { ReadCapacityUnits: CAPACITY_PLAN.byAssignee.read, WriteCapacityUnits: CAPACITY_PLAN.byAssignee.write.max },
    })),
  };
}

export async function createLocalTable(client: DynamoDBClient): Promise<string> {
  const tableName = `tasks-${randomUUID()}`;
  await client.send(new CreateTableCommand(createTableInput(tableName)));
  return tableName;
}

export async function deleteLocalTable(client: DynamoDBClient, tableName: string): Promise<void> {
  await client.send(new DeleteTableCommand({ TableName: tableName }));
}

export async function seed(doc: DynamoDBDocumentClient, tableName: string, items: Item[]): Promise<void> {
  for (let i = 0; i < items.length; i += 25) {
    const out = await doc.send(new BatchWriteCommand({
      RequestItems: { [tableName]: items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })) },
    }));
    if (Object.keys(out.UnprocessedItems ?? {}).length > 0) throw new Error('seed left unprocessed items');
  }
}
