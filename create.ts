import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function createGcpSecretsManagerUpsertAction() {
  return createTemplateAction({
    id: 'gcp:secrets-manager:upsert',
    description:
      'Creates or updates multiple secrets based on user choice, with auto-prefixing or auto-suffixing.',
    schema: {
      input: z =>
        z.object({
          project: z.string().describe('The GCP project ID'),
          operation: z
            .enum(['create', 'update'])
            .describe('Operation to perform: create or update'),
          secret_type: z
            .enum(['gke', 'airflow', 'database_credentials', 'generic'])
            .describe('Type of secret to define the prefix/suffix'),
          secrets: z
            .array(
              z.object({
                name: z.string().describe('Secret Name without prefix/suffix'),
                value: z.string().describe('Secret Value'),
              }),
            )
            .describe('List of secrets'),
          labels: z.record(z.string()).optional(),
        }),
    },

    async handler(ctx) {
      const client = new SecretManagerServiceClient();
      const { project, operation, secret_type, secrets, labels } = ctx.input;

      // ================================
      // 🔄 Mapeamento de projetos
      // ================================
      let gcpProjectId = project;

      if (project === 'stage-1.0') {
        gcpProjectId = 'jeitto-backend-homolog';
      } else if (project === 'homolog-1.0') {
        gcpProjectId = 'jeitto-backend-homolog';
      } else if (project === 'prod-1.0') {
        gcpProjectId = 'jeitto-backend-prod';
      }

      // ================================
      // 🔒 REGRA DE GOVERNANÇA PRODUÇÃO
      // ================================
      const productionProjects = ['jeitto-prod', 'jeitto-backend-prod'];

      if (productionProjects.includes(gcpProjectId) && operation === 'update') {
        const rdmLink = 'https://SEU_LINK_RDM_AQUI';

        const errMsg = `
🚫 ALTERAÇÃO BLOQUEADA EM PRODUÇÃO

Você tentou atualizar uma Secret no projeto de PRODUÇÃO (${gcpProjectId}).

Por motivos de segurança e governança, atualizações em produção não são permitidas via Backstage.

📌 Para realizar essa alteração, é obrigatório abrir uma RDM.

👉 Abra sua RDM aqui:
${rdmLink}
        `;

        ctx.logger.error(errMsg);
        throw new Error(errMsg);
      }

      // ================================
      // 🏷️ Prefixo / Sufixo
      // ================================
      let prefix = '';
      let suffix = '';

      if (secret_type === 'airflow') {
        prefix = 'AIRFLOW_VARIABLES_';
      } else if (
        secret_type === 'database_credentials' ||
        secret_type === 'generic'
      ) {
        prefix = '';
        suffix = '';
      } else if (secret_type === 'gke') {
        switch (project) {
          case 'jeitto-integracao':
            prefix = 'GKE_INTEGRATION_';
            break;
          case 'stage-1.0':
            prefix = 'GKE_STAGE_';
            break;
          case 'jeitto-pre-prod':
            prefix = 'GKE_PRE_PROD_';
            break;
          case 'homolog-1.0':
            prefix = 'GKE_HOMOLOG_';
            break;
          case 'jeitto-prod':
          case 'prod-1.0':
            prefix = 'GKE_PROD_';
            break;
          default:
            throw new Error(
              `⚠️ ALERTA: O projeto '${project}' não possui mapeamento de prefixo GKE configurado.`,
            );
        }
      }

      // ================================
      // 🔁 Loop de secrets
      // ================================
      for (const secretInput of secrets) {
        let safeName = secretInput.name;

        if (
          secret_type !== 'generic' &&
          secret_type !== 'database_credentials'
        ) {
          const knownPrefixes = [
            'GKE_INTEGRATION_',
            'GKE_STAGE_',
            'GKE_HOMOLOG_',
            'GKE_PRE_PROD_',
            'GKE_PROD_',
            'AIRFLOW_VARIABLES_',
          ];

          for (const known of knownPrefixes) {
            if (safeName.startsWith(known)) {
              safeName = safeName.replace(known, '');
            }
          }
        }

        const fullSecretName = `${prefix}${safeName}${suffix}`;

        const secretPath = `projects/${gcpProjectId}/secrets/${fullSecretName}`;
        const parentPath = `projects/${gcpProjectId}`;

        let secretAlreadyExists = false;

        // ================================
        // 🔍 Verifica existência
        // ================================
        try {
          await client.getSecret({ name: secretPath });
          secretAlreadyExists = true;
        } catch (error: unknown) {
          const err = error as any;
          if (err.code === 5) {
            secretAlreadyExists = false;
          } else {
            ctx.logger.error(
              `Erro ao verificar secret [${fullSecretName}]`,
              normalizeError(error),
            );
            throw error;
          }
        }

        // ================================
        // 🚫 CREATE duplicado
        // ================================
        if (operation === 'create' && secretAlreadyExists) {
          throw new Error(
            `⚠️ O secret '${fullSecretName}' já existe em ${gcpProjectId}. Use a opção 'update'.`,
          );
        }

        // ================================
        // 🆕 Criar secret base
        // ================================
        if (!secretAlreadyExists) {
          ctx.logger.info(
            `Criando secret base [${fullSecretName}] em ${gcpProjectId}`,
          );

          await client.createSecret({
            parent: parentPath,
            secretId: fullSecretName,
            secret: {
              labels,
              replication: { automatic: {} },
            },
          });
        }

        // ================================
        // ➕ Nova versão
        // ================================
        let newVersionName = '';

        try {
          const [version] = await client.addSecretVersion({
            parent: secretPath,
            payload: {
              data: Buffer.from(secretInput.value, 'utf8'),
            },
          });

          newVersionName = version.name as string;

          ctx.logger.info(`Nova versão criada: ${newVersionName}`);
        } catch (error: unknown) {
          ctx.logger.error(
            `Erro ao adicionar valor ao secret [${fullSecretName}]`,
            normalizeError(error),
          );
          throw error;
        }

        // ================================
        // 🧹 Limpeza versões antigas
        // ================================
        if (operation === 'update' && secretAlreadyExists) {
          try {
            const [versions] = await client.listSecretVersions({
              parent: secretPath,
            });

            for (const v of versions) {
              if (
                v.name !== newVersionName &&
                (v.state === 'ENABLED' || v.state === 1)
              ) {
                await client.disableSecretVersion({
                  name: v.name as string,
                });
              }
            }
          } catch (error: unknown) {
            ctx.logger.warn(
              `Falha ao limpar versões antigas do secret [${fullSecretName}]`,
              normalizeError(error),
            );
          }
        }
      }
    },
  });
}
