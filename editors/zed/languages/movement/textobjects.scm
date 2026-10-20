(function_declaration
  body: (block "{" (_)* @function.inside "}")) @function.around

(closure
  body: (block "{" (_)* @function.inside "}")) @function.around

(node_declaration
  body: (node_body "{" (_)* @class.inside "}")) @class.around

(comment)+ @comment.around
