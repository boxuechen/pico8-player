pico-8 cartridge // http://www.pico-8.com
version 43
__lua__
function local_env(value,_ENV)
 return flr(value)
end
function _init()
 local packed=pack(4,5)
 _set_fps(60)
 mset(0,0,0)
 mapdraw(0,0,0,0,1,1)
 local sequence=0
 for index,value in inext,{6,7} do sequence+=index+value end
 local xor_value=1~0
 poke(0x5000,packed.n,packed[1],local_env(3.75,{}),sequence,xor_value,stat(7)==30 and 1 or 0)
end
function _update() end
function _draw() end
