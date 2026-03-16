import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

export function createGcpSecretsManagerUpsertAction() {
  return createTemplateAction({
    id: 'gcp:secrets-manager:upsert',
    description: 'Creates or updates multiple secrets based on user choice, with auto-prefixing or auto-suffixing.',
    schema: {
      input: (z) => z.object({
        project: z.string().describe('The GCP project ID'),
        operation: z.enum(['create', 'update']).describe('Operation to perform: create or update'),
        secret_type: z.enum(['gke', 'airflow', 'database_password', 'generic']).describe('Type of secret to define the prefix/suffix'),
        secrets: z.array(
          z.object({
            name: z.string().describe('Secret Name without prefix/suffix'),
            value: z.string().describe('Secret Value'),
          })
        ).describe('List of secrets'),
        labels: z.record(z.string()).optional(),
      }),
    },
    async handler(ctx) {
      const client = new SecretManagerServiceClient();
      const { project, operation, secret_type, secrets, labels } = ctx.input;

      // ==========================================
      // MUDANÇA 1: Traduzir o nome do formulário para o ID real do GCP
      // ==========================================
      let gcpProjectId = project;
      if (project === 'stage-1.0') {
        gcpProjectId = 'jeitto-backend-homolog';
      } else if (project === 'homolog-1.0') {
        gcpProjectId = 'jeitto-backend-homolog';
      } else if (project === 'prod-1.0') {
        gcpProjectId = 'jeitto-backend-prod';
      }

      // 1. Lógica Dinâmica do Prefixo e Sufixo
      let prefix = '';
      let suffix = '';
      
      if (secret_type === 'airflow') {
        prefix = 'AIRFLOW_VARIABLES_';
      } else if (secret_type === 'database_password') {
        suffix = '_DATABASE_PASSWORD'; 
      } else if (secret_type === 'generic') {
        prefix = '';
        suffix = '';
      } else if (secret_type === 'gke') {
        // Continuamos usando o 'project' original (da tela) para decidir o prefixo,
        // pois stage e homolog vão para o mesmo projeto GCP, mas têm prefixos diferentes.
        switch (project) {
          case 'devops-labs-397603':     
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
            throw new Error(`⚠️ ALERTA: O projeto '${project}' não possui mapeamento de prefixo GKE configurado na Action.`);
        }
      }

      for (const secretInput of secrets) {
        
        let safeName = secretInput.name;
        
        if (secret_type !== 'generic') {
          // ==========================================
          // MUDANÇA 2: Adicionamos os novos prefixos na lista de limpeza
          // ==========================================
          const knownPrefixes =[
            'GKE_INTEGRATION_', 
            'GKE_STAGE_',       // NOVO
            'GKE_HOMOLOG_',     // NOVO
            'GKE_PRE_PROD_', 
            'GKE_PROD_', 
            'AIRFLOW_VARIABLES_'
          ];
          const knownSuffixes =[
            '_DATABASE_PASSWORD'
          ];

          for (const known of knownPrefixes) {
            if (safeName.startsWith(known)) {
              safeName = safeName.replace(known, ''); 
            }
          }

          for (const known of knownSuffixes) {
            if (safeName.endsWith(known)) {
              safeName = safeName.slice(0, -known.length);
            }
          }
        }

        // 2. Monta o nome final
        const fullSecretName = `${prefix}${safeName}${suffix}`;
        
        // ==========================================
        // MUDANÇA 3: Usamos 'gcpProjectId' no lugar de 'project' 
        // para conversar com a API do Google
        // ==========================================
        const secretPath = `projects/${gcpProjectId}/secrets/${fullSecretName}`;
        const parentPath = `projects/${gcpProjectId}`;
        let secretAlreadyExists = false;

        // 3. Tenta buscar o secret
        try {
          await client.getSecret({ name: secretPath });
          secretAlreadyExists = true;
        } catch (error: any) {
          if (error.code === 5) { 
            secretAlreadyExists = false;
          } else {
            ctx.logger.error(`Erro ao tentar verificar o secret [${fullSecretName}]:`, error);
            throw error;
          }
        }

        // 4. Regra de Negócio: Se escolheu CREATE mas já existe
        if (operation === 'create' && secretAlreadyExists) {
          const errMsg = `⚠️ ALERTA: O secret '${fullSecretName}' já existe no projeto ${gcpProjectId}! Como você escolheu a opção 'Criar', abortamos a execução para evitar sobrescrever dados por acidente. Se deseja atualizar o valor dessa variável, volte a página anterior e marque a opção 'Atualizar'.`;
          ctx.logger.error(errMsg);
          throw new Error(errMsg);
        }

        // 5. Se não existir, nós criamos a base
        if (!secretAlreadyExists) {
          ctx.logger.info(`Secret base [${fullSecretName}] não encontrado. Criando em ${gcpProjectId}...`);
          await client.createSecret({
            parent: parentPath,
            secretId: fullSecretName,
            secret: {
              labels,
              replication: { automatic: {} },
            },
          });
        }

        // 6. Adiciona a versão do Secret
        let newVersionName = '';
        try {
          ctx.logger.info(`Adicionando valor/versão ao secret[${fullSecretName}]...`);
          const [version] = await client.addSecretVersion({
            parent: secretPath,
            payload: { data: Buffer.from(secretInput.value, 'utf8') },
          });
          newVersionName = version.name as string;
          ctx.logger.info(`✅ Nova versão ativada com sucesso: ${newVersionName}`);
        } catch (error) {
          ctx.logger.error(`Erro ao adicionar valor ao secret[${fullSecretName}]:`, error as Error);
          throw error;
        }

        // 7. Limpeza de Versões Antigas
        if (operation === 'update' && secretAlreadyExists) {
          try {
            ctx.logger.info(`Limpando versões anteriores do secret[${fullSecretName}]...`);
            const [versions] = await client.listSecretVersions({ parent: secretPath });
            
            for (const v of versions) {
              if (v.name !== newVersionName && (v.state === 'ENABLED' || v.state === 1)) {
                 ctx.logger.info(`Desabilitando versão antiga: ${v.name}`);
                 await client.disableSecretVersion({ name: v.name as string });
              }
            }
          } catch (error) {
             ctx.logger.warn(`Aviso: Falha ao tentar desabilitar versões antigas do secret[${fullSecretName}]. Erro: ${error}`);
          }
        }

      } // fim do for
    }, // fim do handler
  }); 
}
