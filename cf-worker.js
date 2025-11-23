/**
 * Cloudflare Worker - Ollama API 代理
 * 功能：转发请求到 ollama.com API，并进行身份验证、跨域处理和格式转换
 * Github: https://github.com/openugc/ollama2openai
 * 公众号：为Ai痴狂
 */

export default {
  async fetch(request, env) {
    // CORS 预检请求处理
    if (request.method === 'OPTIONS') {
      return handleCORS();
    }

    const OLLAMA_KEY = request.headers.get('Authorization');
    try {

      // 解析请求路径
      const url = new URL(request.url);
      const path = url.pathname;

      // 路由匹配和转发
      let targetUrl;
      let method = request.method;
      let needsTransform = false;
      let transformType = null;

      if (path === '/v1/models' && method === 'GET') {
        targetUrl = 'https://ollama.com/api/tags';
        needsTransform = true;
        transformType = 'models';
      } else if (path === '/v1/chat/completions' && method === 'POST') {
        targetUrl = 'https://ollama.com/api/chat';
        needsTransform = true;
        transformType = 'chat';
      } else {
        return createErrorResponse('Endpoint not found', 404);
      }

      // 构建转发请求
      const proxyRequest = await buildProxyRequest(request, targetUrl, OLLAMA_KEY, transformType);
      
      // 发送请求到 ollama.com
      const response = await fetch(proxyRequest);
      
      // 处理不同类型的转换
      if (needsTransform && response.ok) {
        if (transformType === 'models') {
          // 模型列表转换
          const ollamaData = await response.json();
          const openaiData = transformToOpenAIFormat(ollamaData);
          return createJSONResponse(openaiData);
        } else if (transformType === 'chat') {
          // 流式聊天响应转换
          return transformChatStream(response);
        }
      }
      
      // 返回带 CORS 头的响应
      return addCORSHeaders(response);

    } catch (error) {
      console.error('Worker error:', error);
      return createErrorResponse(`Internal server error: ${error.message}`, 500);
    }
  }
};

/**
 * 转换 OpenAI 请求格式为 Ollama 格式
 */
function transformOpenAIRequestToOllama(openaiRequest) {
  try {
    const ollamaRequest = {
      model: openaiRequest.model,
      messages: [],
      stream: openaiRequest.stream !== false, // 默认为 true
    };

    // 转换 messages
    if (openaiRequest.messages && Array.isArray(openaiRequest.messages)) {
      ollamaRequest.messages = openaiRequest.messages.map(msg => {
        const ollamaMsg = {
          role: msg.role,
          content: ''
        };

        // 处理 content（可能是字符串或数组）
        if (typeof msg.content === 'string') {
          // 简单文本内容
          ollamaMsg.content = msg.content;
        } else if (Array.isArray(msg.content)) {
          // 多模态内容（文本 + 图片）
          const textParts = [];
          const images = [];

          for (const part of msg.content) {
            if (part.type === 'text') {
              textParts.push(part.text);
            } else if (part.type === 'image_url') {
              // 处理图片 URL
              let imageData = part.image_url?.url || '';
              
              // 如果是 base64 格式，提取 base64 数据
              if (imageData.startsWith('data:image/')) {
                // 格式: data:image/jpeg;base64,/9j/4AAQ...
                const base64Match = imageData.match(/^data:image\/[^;]+;base64,(.+)$/);
                if (base64Match) {
                  imageData = base64Match[1];
                }
              }
              
              images.push(imageData);
            }
          }

          // Ollama 格式：content 是文本，images 是单独的数组
          ollamaMsg.content = textParts.join('\n');
          
          if (images.length > 0) {
            ollamaMsg.images = images;
          }
        } else {
          // 其他情况，转为字符串
          ollamaMsg.content = String(msg.content || '');
        }

        // 处理 tool_calls（assistant 消息）
        if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
          ollamaMsg.tool_calls = msg.tool_calls.map(tc => {
            // 将 arguments 字符串转换为对象
            let args = tc.function?.arguments;
            if (typeof args === 'string') {
              try {
                args = JSON.parse(args);
              } catch (e) {
                console.error('Failed to parse tool arguments:', args);
                args = {};
              }
            }

            return {
              id: tc.id,
              function: {
                name: tc.function?.name,
                arguments: args // Ollama 需要对象格式
              }
            };
          });
        }

        // 处理 tool 消息（工具执行结果）
        if (msg.role === 'tool') {
          ollamaMsg.role = 'tool';
          ollamaMsg.content = msg.content;
          if (msg.tool_call_id) {
            ollamaMsg.tool_call_id = msg.tool_call_id;
          }
        }

        return ollamaMsg;
      });
    }

    // 转换 tools
    if (openaiRequest.tools && Array.isArray(openaiRequest.tools)) {
      ollamaRequest.tools = openaiRequest.tools.map(tool => {
        return {
          type: tool.type || 'function',
          function: {
            name: tool.function?.name,
            description: tool.function?.description,
            parameters: tool.function?.parameters
          }
        };
      });
    }

    // 其他参数
    if (openaiRequest.temperature !== undefined) {
      ollamaRequest.temperature = openaiRequest.temperature;
    }
    if (openaiRequest.top_p !== undefined) {
      ollamaRequest.top_p = openaiRequest.top_p;
    }
    if (openaiRequest.max_tokens !== undefined) {
      ollamaRequest.num_predict = openaiRequest.max_tokens;
    }

    return ollamaRequest;
  } catch (error) {
    console.error('Request transformation error:', error);
    throw error;
  }
}
/**
 * 转换聊天流式响应为 OpenAI 格式
 */
function transformChatStream(ollamaResponse) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  
  // 生成唯一的请求 ID
  const chatId = generateChatId();
  const created = Math.floor(Date.now() / 1000);
  
  let tokenCount = 0;
  let model = '';
  let isFirstChunk = true;

  // 处理流式数据
  (async () => {
    try {
      const reader = ollamaResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        
        if (done) {
          // 发送结束标记
          await writer.write(encoder.encode('data: [DONE]\n\n'));
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // 保留不完整的行

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const ollamaChunk = JSON.parse(line);
            
            // 保存模型名称
            if (ollamaChunk.model) {
              model = ollamaChunk.model;
            }

            // 转换为 OpenAI 格式
            const openaiChunk = convertOllamaChunkToOpenAI(
              ollamaChunk, 
              chatId, 
              created, 
              model,
              tokenCount,
              isFirstChunk
            );

            if (openaiChunk) {
              // 更新 token 计数
              if (ollamaChunk.message?.content || ollamaChunk.message?.tool_calls) {
                tokenCount++;
              }
              
              isFirstChunk = false;

              // 写入转换后的数据
              const data = `data: ${JSON.stringify(openaiChunk)}\n\n`;
              await writer.write(encoder.encode(data));
            }

          } catch (e) {
            console.error('Error parsing chunk:', e, 'Line:', line);
          }
        }
      }

    } catch (error) {
      console.error('Stream error:', error);
    } finally {
      await writer.close();
    }
  })();

  // 返回 SSE 响应
  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }
  });
}

/**
 * 将单个 Ollama 数据块转换为 OpenAI 格式
 */
function convertOllamaChunkToOpenAI(ollamaChunk, chatId, created, model, tokenCount, isFirstChunk) {
  const message = ollamaChunk.message || {};
  const content = message.content || '';
  const thinking = message.thinking || '';
  const toolCalls = message.tool_calls || null;
  const isDone = ollamaChunk.done || false;
  const doneReason = ollamaChunk.done_reason || null;

  // 构建基础结构
  const openaiChunk = {
    id: chatId,
    object: 'chat.completion.chunk',
    created: created,
    model: model,
    choices: [{
      index: 0,
      delta: {},
      finish_reason: null,
      content_filter_results: {
        hate: { filtered: false },
        self_harm: { filtered: false },
        sexual: { filtered: false },
        violence: { filtered: false },
        jailbreak: { filtered: false, detected: false },
        profanity: { filtered: false, detected: false }
      }
    }],
    system_fingerprint: '',
    usage: {
      prompt_tokens: ollamaChunk.prompt_eval_count || 24,
      completion_tokens: ollamaChunk.eval_count || tokenCount,
      total_tokens: (ollamaChunk.prompt_eval_count || 24) + (ollamaChunk.eval_count || tokenCount),
      prompt_tokens_details: null,
      completion_tokens_details: {
        audio_tokens: 0,
        reasoning_tokens: thinking ? 1 : 0,
        accepted_prediction_tokens: 0,
        rejected_prediction_tokens: 0
      }
    }
  };

  // 第一个块包含 role
  if (isFirstChunk) {
    openaiChunk.choices[0].delta.role = 'assistant';
  }

  // 添加文本内容
  if (content) {
    openaiChunk.choices[0].delta.content = content;
    openaiChunk.choices[0].delta.role = 'assistant';
  }

  // 处理工具调用
  if (toolCalls && Array.isArray(toolCalls)) {
    openaiChunk.choices[0].delta.role = 'assistant';
    openaiChunk.choices[0].delta.tool_calls = toolCalls.map(tool => {
      return {
        index: tool.function?.index || 0,
        id: tool.id || generateToolCallId(),
        type: 'function',
        function: {
          name: tool.function?.name || '',
          arguments: typeof tool.function?.arguments === 'string' 
            ? tool.function.arguments 
            : JSON.stringify(tool.function?.arguments || {})
        }
      };
    });
  }

  // 处理完成状态
  if (isDone) {
    openaiChunk.choices[0].finish_reason = doneReason === 'stop' ? 'stop' : 
                                           toolCalls ? 'tool_calls' : 'length';
    // 最后一个块如果没有内容和工具调用，只保留 role
    if (!content && !toolCalls) {
      openaiChunk.choices[0].delta = { role: 'assistant' };
    }
  }

  return openaiChunk;
}

/**
 * 生成聊天 ID
 */
function generateChatId() {
  const chars = '0123456789abcdef';
  let id = '';
  for (let i = 0; i < 32; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

/**
 * 生成工具调用 ID
 */
function generateToolCallId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  let id = 'call_';
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

/**
 * 将 Ollama 格式转换为 OpenAI 格式（模型列表）
 */
function transformToOpenAIFormat(ollamaData) {
  if (!ollamaData || !ollamaData.models || !Array.isArray(ollamaData.models)) {
    return {
      object: "list",
      data: []
    };
  }

  const transformedModels = ollamaData.models.map(model => {
    let created = Math.floor(Date.now() / 1000);
    
    if (model.modified_at) {
      try {
        created = Math.floor(new Date(model.modified_at).getTime() / 1000);
      } catch (e) {
        console.warn('Failed to parse modified_at:', model.modified_at);
      }
    }

    return {
      id: model.name || model.model,
      object: "model",
      created: created,
      owned_by: "ollama"
    };
  });

  return {
    object: "list",
    data: transformedModels
  };
}

/**
 * 验证请求的 Authorization 头
 */
function authenticateRequest(request, authKey) {
  if (!authKey) {
    return { valid: false, message: 'Server configuration error: AUTH_KEY not set' };
  }

  const authHeader = request.headers.get('Authorization');
  
  if (!authHeader) {
    return { valid: false, message: 'Missing Authorization header' };
  }

  const expectedAuth = `Bearer ${authKey}`;
  
  if (authHeader !== expectedAuth) {
    return { valid: false, message: 'Invalid authorization token' };
  }

  return { valid: true };
}

/**
 * 构建代理请求
 */
async function buildProxyRequest(originalRequest, targetUrl, ollamaKey, transformType) {
  const headers = new Headers(originalRequest.headers);
  
  headers.delete('Authorization');
  
  if (ollamaKey) {
    headers.set('Authorization', ollamaKey);
  }
  
  headers.set('Host', 'ollama.com');
  headers.set('Origin', 'https://ollama.com');
  
  const requestInit = {
    method: originalRequest.method,
    headers: headers,
  };

  // 如果是 POST 请求，需要转换请求体
  if (originalRequest.method === 'POST') {
    const originalBody = await originalRequest.text();
    
    // 如果是聊天请求，转换格式
    if (transformType === 'chat') {
      try {
        const openaiRequest = JSON.parse(originalBody);
        const ollamaRequest = transformOpenAIRequestToOllama(openaiRequest);
        requestInit.body = JSON.stringify(ollamaRequest);
        headers.set('Content-Type', 'application/json');
      } catch (e) {
        console.error('Failed to transform request:', e);
        requestInit.body = originalBody; // 转换失败，使用原始请求体
      }
    } else {
      requestInit.body = originalBody;
    }
  }

  return new Request(targetUrl, requestInit);
}

/**
 * 处理 CORS 预检请求
 */
function handleCORS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    }
  });
}

/**
 * 为响应添加 CORS 头
 */
function addCORSHeaders(response) {
  const newResponse = new Response(response.body, response);
  
  newResponse.headers.set('Access-Control-Allow-Origin', '*');
  newResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  newResponse.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  return newResponse;
}

/**
 * 创建 JSON 响应
 */
function createJSONResponse(data, status = 200) {
  const response = new Response(
    JSON.stringify(data), 
    {
      status: status,
      headers: {
        'Content-Type': 'application/json',
      }
    }
  );
  
  return addCORSHeaders(response);
}

/**
 * 创建错误响应
 */
function createErrorResponse(message, status = 400) {
  const response = new Response(
    JSON.stringify({ error: message }), 
    {
      status: status,
      headers: {
        'Content-Type': 'application/json',
      }
    }
  );
  
  return addCORSHeaders(response);
}
