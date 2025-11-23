# ollama2openai
将Ollama的API接口转换为OpenAI标准的接口    
> Convert Ollama’s API endpoints to the OpenAI standard.

## 项目功能
- 转换`GET https://ollama.com/api/tags` => `https://your-site/v1/models`    
- 转换`POST https://ollama.com/api/tags` => `https://your-site/v1/chat/completions`

同时，处理了OLLAMA接口返回的模型列表格式、对话数据流、工具调用、以及请求的多个Content内容的兼容问题。    
经过测试，已经能够在各大AI客户端中进行正常对话、工具调用、图片识别等。    
当然，可能还会有未知的未完善的地方，欢迎提ISSUE    

## 脚本使用
复制`cf-worker.js`代码，到`CloudFlare`的`Workers`中新建、粘贴、部署使用，获取链接（国内需绑定域名），即可使用。    

获取到链接之后，再各大AI客户端中配置自定义OPENAI格式的大模型接口，KEY填写OLLAMA申请的KEY即可

## 懒人版
- 直接使用部署好的：https://ollama.openugc.com/v1
- 在线AI客户端：https://chat.openugc.com
