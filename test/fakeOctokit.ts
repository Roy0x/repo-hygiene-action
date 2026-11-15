export interface FakeLabel {
  name: string;
  color: string;
  description?: string;
}

export interface FakeComment {
  id: number;
  body: string;
  user: { login: string; type: 'Bot' | 'User' };
}

interface FakeOptions {
  labels?: FakeLabel[];
  comments?: FakeComment[];
  selfLogin?: string;
  createLabelError?: number;
  createCommentError?: number;
}

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/**
 * In-memory stand-in for the Octokit surface this action uses.
 * Mutating calls record what happened so tests can assert on them.
 */
export class FakeOctokit {
  readonly labels: FakeLabel[];
  readonly comments: FakeComment[];
  readonly createdLabels: FakeLabel[] = [];
  readonly createdComments: string[] = [];
  readonly updatedComments: Array<{ id: number; body: string }> = [];
  readonly selfLogin: string;
  createLabelAttempts = 0;

  private readonly createLabelError?: number;
  private readonly createCommentError?: number;
  private nextCommentId = 1;

  constructor(options: FakeOptions = {}) {
    this.labels = [...(options.labels ?? [])];
    this.comments = [...(options.comments ?? [])];
    this.selfLogin = options.selfLogin ?? 'hygiene-bot';
    this.createLabelError = options.createLabelError;
    this.createCommentError = options.createCommentError;
  }

  readonly rest = {
    issues: {
      listComments: async (_params: { issue_number: number }) => ({ data: this.comments }),
      createComment: async (params: { body: string }) => {
        if (this.createCommentError !== undefined) {
          throw httpError(this.createCommentError, 'Resource not accessible by integration');
        }
        const comment: FakeComment = {
          id: this.nextCommentId++,
          body: params.body,
          user: {
            login: this.selfLogin,
            type: this.selfLogin.endsWith('[bot]') ? 'Bot' : 'User',
          },
        };
        this.comments.push(comment);
        this.createdComments.push(params.body);
        return { data: comment };
      },
      updateComment: async (params: { comment_id: number; body: string }) => {
        const existing = this.comments.find((comment) => comment.id === params.comment_id);
        if (!existing) {
          throw httpError(404, 'Not Found');
        }
        existing.body = params.body;
        this.updatedComments.push({ id: params.comment_id, body: params.body });
        return { data: existing };
      },
      listLabelsForRepo: async () => ({ data: this.labels }),
      createLabel: async (params: FakeLabel & { owner: string; repo: string }) => {
        this.createLabelAttempts += 1;
        if (this.createLabelError !== undefined) {
          throw httpError(
            this.createLabelError,
            this.createLabelError === 422 ? 'Validation Failed' : 'Forbidden',
          );
        }
        const label: FakeLabel = {
          name: params.name,
          color: params.color,
          description: params.description,
        };
        this.labels.push(label);
        this.createdLabels.push(label);
        return { data: label };
      },
    },
    users: {
      getAuthenticated: async () => ({ data: { login: this.selfLogin } }),
    },
  };

  readonly paginate = {
    iterator: (method: (params: unknown) => Promise<{ data: unknown[] }>, params: unknown) => {
      const pages = async function* () {
        yield await method(params);
      };
      return pages();
    },
  };
}
