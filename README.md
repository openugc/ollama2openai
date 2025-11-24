# ollama2openai
将Ollama的API接口转换为OpenAI标准的接口    
> Convert Ollama’s API endpoints to the OpenAI standard.

## 项目功能 Project Features
- 转换 Convert `GET https://ollama.com/api/tags` => `https://your-site/v1/models`    
- 转换 Convert `POST https://ollama.com/api/chat` => `https://your-site/v1/chat/completions`

同时，处理了OLLAMA接口返回的模型列表格式、对话数据流、工具调用、以及请求的多个Content内容的兼容问题。  
经过测试，已经能够在各大AI客户端中进行正常对话、工具调用、图片识别等。  
当然，可能还会有未知的未完善的地方，欢迎提ISSUE  

> At the same time, I handled the OLLAMA interface’s model-list format, streaming chat data, tool calls, and compatibility with multi-part Content requests.  
> Testing shows it now supports normal conversations, tool calls, and image recognition in major AI clients.  
> Of course, unknown issues may still exist—feel free to open an ISSUE.

## 脚本使用 How to use
复制`cf-worker.js`代码，到`CloudFlare`的`Workers`中新建、粘贴、部署使用，获取链接（国内需绑定域名），即可使用。    
获取到链接之后，再各大AI客户端中配置自定义OPENAI格式的大模型接口，KEY填写OLLAMA申请的KEY即可

> Copy the `cf-worker.js` code, create a new Worker in Cloudflare, paste the code, deploy it, and obtain the link (a custom domain is required in mainland China) to start using it.
> After obtaining the link, configure a custom OpenAI-compatible endpoint in your AI client, and fill in the KEY you applied for from OLLAMA.

## 懒人版
- 直接使用部署好的：https://ollama.openugc.com/v1
- 在线AI客户端：https://chat.openugc.com
